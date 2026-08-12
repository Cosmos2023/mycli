import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { parseJsonRpcMessage, type RuntimeStateRecord } from "@mycli/contracts";
import { fingerprintSubmission, rootAgentPath } from "@mycli/core";
import { SQLiteSessionStore, subagentRunId } from "@mycli/storage";
import { renderMycliShell } from "mycli-shell-tui";
import type { GatewayEvent } from "../../../../tui/mycli-shell/src/adapters/gateway-client.ts";
import { GatewayEventDeduper } from "../../../../tui/mycli-shell/src/adapters/gateway-events.ts";
import {
	initialRuntimeState,
	projectRuntimeState,
	reduceRuntimeEvent,
} from "../../../../tui/mycli-shell/src/adapters/runtime-state.ts";
import { startNodeBackend } from "../src/node-runtime/node-backend.ts";

function finalMessageCount(messages: readonly Record<string, unknown>[]): number {
	return messages.filter((message) => {
		if (message.method !== "message.complete") return false;
		const params = message.params as Record<string, unknown> | undefined;
		return params?.final === true;
	}).length;
}

test("Node backend becomes ready before an uncached MCP discovery completes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-background-mcp-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	const mycli = join(workspace, ".mycli");
	await Promise.all([mkdir(home), mkdir(mycli, { recursive: true })]);
	await writeFile(join(mycli, "mcp_servers.toml"), [
		"[servers.blocked]",
		'transport = "stdio"',
		`command = ${JSON.stringify(process.execPath)}`,
		`args = ["-e", "setInterval(() => {}, 1000)"]`,
		"timeout_seconds = 10",
	].join("\n"), "utf8");
	t.after(() => rm(root, { recursive: true, force: true }));

	const startup = startNodeBackend({
		cwd: workspace,
		args: ["--session", "background-mcp-session", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: "http://127.0.0.1:1/v1",
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_MEMORY_ENABLED: "false",
		},
	});
	const backend = await Promise.race([
		startup,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("backend startup waited for MCP discovery")), 2_000);
		}),
	]);
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"), 1_000);
	assert.equal(event(messages, "extension.updated"), undefined);

	writeRequest(backend, "shutdown-background-mcp", "shutdown", {});
	assert.equal(await backend.completion, 0);
});

test("Node backend composes config, provider streaming, gateway, and SQLite", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-backend-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(home);
	await mkdir(workspace);
	let requests = 0;
	const capture: { requestBody?: Record<string, unknown> } = {};
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			requests += 1;
			capture.requestBody = JSON.parse(body) as Record<string, unknown>;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello from node\"}\n\n");
			response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_node\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3,\"total_tokens\":5}}}\n\n");
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "integration-session", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
			MYCLI_PYTHON: join(root, "python-must-not-start"),
		},
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	writeRequest(backend, "shell-list", "shell.list", {});
	const shellList = await waitFor(() => response(messages, "shell-list"));
	assert.deepEqual(shellList.result, {
		session_id: "integration-session",
		generation: 1,
		shells: [],
	});
	writeRequest(backend, "shell-stop-all", "shell.stop_all", {});
	const shellStopAll = await waitFor(() => response(messages, "shell-stop-all"));
	assert.deepEqual(shellStopAll.result, {
		session_id: "integration-session",
		generation: 1,
		stopped: 0,
		shells: [],
	});
	writeRequest(backend, "1", "turn.submit", {
		message: "hello",
		client_turn_id: "integration-turn",
		client_user_message_id: "integration-message",
	});
	const userStarted = await waitFor(() => event(messages, "item.started"));
	const userCompleted = await waitFor(() => event(messages, "item.completed"));
	assert.deepEqual(userStarted.params, {
		client_turn_id: "integration-turn",
		turn_id: (userStarted.params as Record<string, unknown>).turn_id,
		item: {
			id: `${String((userStarted.params as Record<string, unknown>).turn_id)}:user:integration-message`,
			type: "user_message",
			client_user_message_id: "integration-message",
			content: "hello",
			source: "submit",
		},
	});
	assert.deepEqual(userCompleted.params, userStarted.params);
	let final: Record<string, unknown>;
	try {
		final = await waitFor(() => messages.find((message) => {
			if (message.method !== "message.complete") return false;
			const params = message.params as Record<string, unknown> | undefined;
			return params?.final === true;
		}));
	} catch {
		assert.fail(JSON.stringify(messages.map((message) => ({
			method: message.method,
			code: paramValue(message, "code") ?? errorValue(message, "code"),
			state: paramValue(message, "state"),
		}))));
	}
	const submitResponse = await waitFor(() => response(messages, "1"));
	const submittedTurnId = resultValue(submitResponse, "turn_id");
	assert.equal(messages.indexOf(userCompleted), messages.findIndex(
		(message) => message.method === "item.completed",
	));
	assert.ok(messages.indexOf(userCompleted) < messages.findIndex(
		(message) => message.method === "message.delta",
	));
	assert.equal((final.params as Record<string, unknown>).text, "hello from node");
	assert.equal(requests, 1);
	assert.equal(capture.requestBody?.model, "gpt-test");
	assert.equal(capture.requestBody?.stream, true);
	const modelInput = JSON.stringify(capture.requestBody?.input);
	assert.match(modelInput, new RegExp(
		`shell: ${process.platform === "win32" ? "cmd" : "sh"}`,
		"u",
	));
	assert.match(modelInput, new RegExp(
		`shell_kind: ${process.platform === "win32" ? "cmd" : "posix"}`,
		"u",
	));
	assert.equal(modelInput.includes(process.platform === "win32" ? "cmd.exe" : "/bin/sh"), false);
	assert.deepEqual(
		(capture.requestBody?.tools as Array<Record<string, unknown>> | undefined)
			?.map((tool) => tool.name),
			[
				"Read", "Edit", "Patch", "Write", "AskUserQuestion", "update_plan", "web_fetch",
				"tool_search", "Skill",
				"spawn_agent", "send_message", "followup_task", "interrupt_agent", "list_agents",
				"wait_agent",
		],
	);
	assert.equal(existsSync(join(home, ".mycli", "sessions.db")), true);
	await waitFor(() => event(messages, "status.changed"));
	writeRequest(backend, "transcript", "transcript.load", {
		session_id: "integration-session",
	});
	const transcriptResponse = await waitFor(() => response(messages, "transcript"));
	const transcriptItems = resultValue(transcriptResponse, "items") as readonly Record<string, unknown>[];
	assert.deepEqual(transcriptItems.slice(0, 2).map((item) => ({
		id: item.id,
		type: item.type,
		text: item.text,
	})), [
		{ id: `${submittedTurnId}:user:integration-message`, type: "user", text: "hello" },
		{ id: `${submittedTurnId}:assistant:1`, type: "assistant_final", text: "hello from node" },
	]);
	writeRequest(backend, "duplicate", "turn.submit", {
		message: "hello",
		client_turn_id: "integration-turn",
		client_user_message_id: "integration-message",
	});
	await waitFor(() => messages.filter((message) => {
		if (message.method !== "message.complete") return false;
		const params = message.params as Record<string, unknown> | undefined;
		return params?.final === true;
	}).length === 2);
	assert.equal(requests, 1);

	writeRequest(backend, "new-session", "session.new", {});
	const newSessionResponse = await waitFor(() => response(messages, "new-session"));
	const newSessionId = resultValue(newSessionResponse, "session_id");
	assert.equal(typeof newSessionId, "string");
	assert.notEqual(newSessionId, "integration-session");
	assert.equal(resultValue(newSessionResponse, "generation"), 2);

	writeRequest(backend, "new-session-turn", "turn.submit", {
		message: "hello from a new session",
		client_turn_id: "new-session-turn",
		client_user_message_id: "new-session-message",
	});
	await waitFor(() => messages.filter((message) => {
		if (message.method !== "message.complete") return false;
		const params = message.params as Record<string, unknown> | undefined;
		return params?.final === true;
	}).length === 3);
	await waitFor(() => response(messages, "new-session-turn"));
	assert.equal(requests, 2);

	writeRequest(backend, "new-session-transcript", "transcript.load", {
		session_id: newSessionId,
	});
	const newTranscriptResponse = await waitFor(() => response(messages, "new-session-transcript"));
	const newTranscriptItems = resultValue(newTranscriptResponse, "items") as readonly Record<string, unknown>[];
	assert.deepEqual(newTranscriptItems.slice(0, 2).map((item) => ({
		type: item.type,
		text: item.text,
	})), [
		{ type: "user", text: "hello from a new session" },
		{ type: "assistant_final", text: "hello from node" },
	]);

	writeRequest(backend, "2", "shutdown", {});
	assert.equal(await backend.completion, 0);
	assert.equal(existsSync(join(home, ".mycli", "projects")), false);
	const snapshot = JSON.parse(await readFile(
		join(home, ".mycli", "sessions", "integration-session", "session.json"),
		"utf8",
	)) as Record<string, unknown>;
	assert.equal(snapshot.schema_version, 2);
	assert.equal(snapshot.session_id, "integration-session");
	assert.equal(snapshot.state, "idle");
	assert.equal(JSON.stringify(snapshot.transcript).includes("hello from node"), true);
	const newSessionSnapshot = JSON.parse(await readFile(
		join(home, ".mycli", "sessions", String(newSessionId), "session.json"),
		"utf8",
	)) as Record<string, unknown>;
	assert.equal(newSessionSnapshot.session_id, newSessionId);
	assert.equal(newSessionSnapshot.state, "idle");
	assert.equal(
		JSON.stringify(newSessionSnapshot.transcript).includes("hello from a new session"),
		true,
	);
	const reopened = new SQLiteSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		const userHistory = reopened.loadHistoryItems("integration-session")[0];
		assert.equal(userHistory?.id, `${submittedTurnId}:user:integration-message`);
		const continuation = reopened.loadState(
			"integration-session",
			"responses_continuation_state",
		) as Record<string, unknown> | undefined;
		assert.equal(continuation?.response_id, "resp_node");
		assert.equal(continuation?.eligible, true);
		assert.equal(continuation?.session_id, "integration-session");
		assert.equal(continuation?.protocol, "responses");
		assert.equal(continuation?.model, "gpt-test");
		assert.equal(continuation?.history_boundary, submittedTurnId);
		assert.equal(reopened.loadHistoryItems(String(newSessionId))[0]?.text, "hello from a new session");
	} finally {
		reopened.close();
	}
});

test("Node backend executes update_plan and restores its model-hidden transcript item", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-plan-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	const requestBodies: Record<string, unknown>[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			requestBodies.push(JSON.parse(body) as Record<string, unknown>);
			response.writeHead(200, { "content-type": "text/event-stream" });
			if (requestBodies.length === 1) {
				response.write(`data: ${JSON.stringify({
					type: "response.output_item.done",
					item: {
						type: "function_call",
						call_id: "call-plan",
						name: "update_plan",
						arguments: JSON.stringify({
							explanation: "Start implementation",
							plan: [
								{ step: "Inspect runtime", status: "completed" },
								{ step: "Wire plan updates", status: "in_progress" },
							],
						}),
					},
				})}\n\n`);
				response.write('data: {"type":"response.completed","response":{"id":"resp-plan"}}\n\n');
			} else {
				response.write('data: {"type":"response.output_text.delta","delta":"Plan recorded."}\n\n');
				response.write('data: {"type":"response.completed","response":{"id":"resp-final"}}\n\n');
			}
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "plan-session", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	writeRequest(backend, "submit-plan", "turn.submit", {
		message: "Plan the implementation.",
		client_turn_id: "plan-turn",
		client_user_message_id: "plan-message",
	});
	const update = await waitFor(() => event(messages, "plan.updated"));
	assert.deepEqual(update.params, {
		client_turn_id: "plan-turn",
		plan_steps: ["completed: Inspect runtime", "in_progress: Wire plan updates"],
		plan: {
			items: [
				{ id: "step-1", text: "Inspect runtime", status: "completed" },
				{ id: "step-2", text: "Wire plan updates", status: "in_progress" },
			],
		},
		source: "update_plan",
		completed: 1,
		total: 2,
		explanation: "Start implementation",
	});
	await waitFor(() => messages.find((message) =>
		message.method === "message.complete" && paramValue(message, "final") === true));
	assert.equal(requestBodies.length, 2);
	assert.equal(toolNames(requestBodies[0]?.tools).includes("update_plan"), true);
	assert.match(JSON.stringify(requestBodies[1]?.input), /Plan updated\./u);

	writeRequest(backend, "plan-transcript", "transcript.load", { session_id: "plan-session" });
	const transcript = await waitFor(() => response(messages, "plan-transcript"));
	const items = resultValue(transcript, "items") as readonly Record<string, unknown>[];
	const restored = items.find((item) => item.type === "plan_update");
	assert.equal(restored?.text, "Updated Plan");
	assert.deepEqual((restored?.metadata as Record<string, unknown> | undefined)?.items, [
		{ id: "step-1", text: "Inspect runtime", status: "completed" },
		{ id: "step-2", text: "Wire plan updates", status: "in_progress" },
	]);
	assert.equal(
		(restored?.metadata as Record<string, unknown> | undefined)?.explanation,
		"Start implementation",
	);

	writeRequest(backend, "shutdown-plan", "shutdown", {});
	assert.equal(await backend.completion, 0);
	const store = new SQLiteSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		assert.deepEqual(store.loadConversationItems("plan-session").map((item) => item.type), [
			"user", "assistant_tool_calls", "tool_result", "assistant",
		]);
	} finally {
		store.close();
	}
});

test("Node backend sends and persists local image attachments", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-image-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	const imagePath = join(workspace, "sample.png");
	const imageData = Buffer.from("image-data");
	await writeFile(imagePath, imageData);
	let requestBody: Record<string, unknown> | undefined;
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			requestBody = JSON.parse(body) as Record<string, unknown>;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write('data: {"type":"response.output_text.delta","delta":"described"}\n\n');
			response.write('data: {"type":"response.completed","response":{"id":"resp_image","usage":{}}}\n\n');
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve, reject) => server.close(
			(error) => error ? reject(error) : resolve(),
		));
		await rm(root, { recursive: true, force: true });
	});
	const address = server.address();
	assert(address && typeof address === "object");
	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "image-session", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	t.after(() => backend.close().catch(() => undefined));
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));

	writeRequest(backend, "image-submit", "turn.submit", {
		message: "describe",
		client_turn_id: "image-turn",
		client_user_message_id: "image-message",
		local_images: [imagePath],
	});
	await waitFor(() => messages.find((message) => {
		if (message.method !== "message.complete") return false;
		return (message.params as Record<string, unknown> | undefined)?.final === true;
	}));
	const input = requestBody?.input as readonly Record<string, unknown>[] | undefined;
	const user = input?.find((item) => (
		item.role === "user"
		&& Array.isArray(item.content)
		&& item.content.some((part) => (
			typeof part === "object"
			&& part !== null
			&& "type" in part
			&& part.type === "input_image"
		))
	));
	assert.deepEqual(user?.content, [
		{ type: "input_text", text: "describe" },
		{
			type: "input_image",
			image_url: `data:image/png;base64,${imageData.toString("base64")}`,
		},
	]);

	writeRequest(backend, "image-shutdown", "shutdown", {});
	assert.equal(await backend.completion, 0);
	const reopened = new SQLiteSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		assert.deepEqual(reopened.loadConversationItems("image-session")[0], {
			type: "user",
			text: "describe",
			images: [{ mediaType: "image/png", data: imageData.toString("base64") }],
		});
	} finally {
		reopened.close();
	}
});

test("Node backend projects consumed and deferred steering into TUI transcripts", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-steering-transcript-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	await writeFile(join(workspace, "README.md"), "steering fixture\n", "utf8");
	const requestBodies: Record<string, unknown>[] = [];
	let releaseFirstResponse!: () => void;
	const firstResponseReleased = new Promise<void>((resolve) => {
		releaseFirstResponse = resolve;
	});
	let releaseDeferredParentResponse!: () => void;
	const deferredParentResponseReleased = new Promise<void>((resolve) => {
		releaseDeferredParentResponse = resolve;
	});
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			requestBodies.push(JSON.parse(body) as Record<string, unknown>);
			response.writeHead(200, { "content-type": "text/event-stream" });
			if (requestBodies.length === 1) {
				void firstResponseReleased.then(() => {
					response.write(`data: ${JSON.stringify({
						type: "response.output_item.done",
						item: {
							type: "function_call",
							call_id: "call-read-steering",
							name: "Read",
							arguments: JSON.stringify({ file_path: "README.md", offset: 1, limit: 20 }),
						},
					})}\n\n`);
					response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-steering-tools\"}}\n\n");
					response.end("data: [DONE]\n\n");
				});
				return;
			}
			if (requestBodies.length === 2) {
				response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Steering received.\"}\n\n");
				response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-steering-final\"}}\n\n");
				response.end("data: [DONE]\n\n");
				return;
			}
			if (requestBodies.length === 3) {
				void deferredParentResponseReleased.then(() => {
					response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Parent finished without tools.\"}\n\n");
					response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-deferred-parent\"}}\n\n");
					response.end("data: [DONE]\n\n");
				});
				return;
			}
			response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Deferred steering received.\"}\n\n");
			response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-deferred-steering\"}}\n\n");
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "steering-transcript-session", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	const messages: Array<Record<string, unknown>> = [];
	const eventDeduper = new GatewayEventDeduper();
	let tuiState = initialRuntimeState();
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		const message = parseJsonRpcMessage(JSON.parse(line));
		messages.push(message as Record<string, unknown>);
		if ("method" in message && !("id" in message)) {
			const gatewayEvent = message as GatewayEvent;
			if (eventDeduper.shouldConsume(gatewayEvent)) {
				tuiState = reduceRuntimeEvent(tuiState, gatewayEvent.method, gatewayEvent.params);
			}
		}
	});
	await waitFor(() => event(messages, "runtime.ready"));
	writeRequest(backend, "submit-steering", "turn.submit", {
		message: "Inspect README.md",
		client_turn_id: "steering-parent-turn",
		client_user_message_id: "steering-parent-message",
	});
	const started = await waitFor(() => event(messages, "turn.started"));
	const activeTurnId = paramValue(started, "turn_id");
	assert.equal(typeof activeTurnId, "string");
	writeRequest(backend, "steer", "turn.steer", {
		message: "Also inspect package.json",
		client_user_message_id: "steering-user-message",
		expected_turn_id: activeTurnId,
	});
	const accepted = await waitFor(() => response(messages, "steer"));
	assert.equal(resultValue(accepted, "disposition"), "accepted_for_turn");
	releaseFirstResponse();

	const committed = await waitFor(() => messages.find((message) =>
		message.method === "item.completed"
		&& (paramValue(message, "item") as Record<string, unknown> | undefined)
			?.client_user_message_id === "steering-user-message"), 5_000);
	const final = await waitFor(() => messages.find((message) =>
		message.method === "message.complete"
		&& paramValue(message, "final") === true), 5_000);
	assert.equal(paramValue(final, "text"), "Steering received.");
	assert.equal((paramValue(committed, "item") as Record<string, unknown>).content, "Also inspect package.json");
	assert.equal(requestBodies.length, 2);
	assert.equal(JSON.stringify(requestBodies[1]?.input).includes("Also inspect package.json"), true);
	assert.deepEqual(projectRuntimeState(tuiState).messages.filter(
		(message) => message.role === "user",
	).map((message) => message.text), [
		"Inspect README.md",
		"Also inspect package.json",
	]);

	writeRequest(backend, "submit-deferred-parent", "turn.submit", {
		message: "Finish without another tool",
		client_turn_id: "deferred-parent-turn",
		client_user_message_id: "deferred-parent-message",
	});
	const deferredParentStarted = await waitFor(() => messages.find((message) =>
		message.method === "turn.started"
		&& paramValue(message, "client_turn_id") === "deferred-parent-turn"));
	const deferredParentTurnId = paramValue(deferredParentStarted, "turn_id");
	assert.equal(typeof deferredParentTurnId, "string");
	writeRequest(backend, "deferred-steer", "turn.steer", {
		message: "Run this as the next turn",
		client_user_message_id: "deferred-steering-message",
		expected_turn_id: deferredParentTurnId,
	});
	const deferredAccepted = await waitFor(() => response(messages, "deferred-steer"));
	assert.equal(resultValue(deferredAccepted, "disposition"), "accepted_for_turn");
	releaseDeferredParentResponse();
	const deferredCommitted = await waitFor(() => messages.find((message) =>
		message.method === "item.completed"
		&& paramValue(message, "client_turn_id") === "deferred-steering-message"
		&& (paramValue(message, "item") as Record<string, unknown> | undefined)
			?.client_user_message_id === "deferred-steering-message"), 5_000);
	assert.equal(
		(paramValue(deferredCommitted, "item") as Record<string, unknown>).content,
		"Run this as the next turn",
	);
	await waitFor(() => messages.find((message) =>
		message.method === "message.complete"
		&& paramValue(message, "client_turn_id") === "deferred-steering-message"
		&& paramValue(message, "final") === true), 5_000);
	assert.equal(requestBodies.length, 4);
	assert.deepEqual(projectRuntimeState(tuiState).messages.filter(
		(message) => message.role === "user",
	).map((message) => message.text), [
		"Inspect README.md",
		"Also inspect package.json",
		"Finish without another tool",
		"Run this as the next turn",
	]);
	const renderedTranscript = renderMycliShell(projectRuntimeState(tuiState), 100).join("\n");
	assert.match(renderedTranscript, /Also inspect package\.json/);
	assert.match(renderedTranscript, /Run this as the next turn/);

	writeRequest(backend, "steering-transcript", "transcript.load", {
		session_id: "steering-transcript-session",
	});
	const transcript = await waitFor(() => response(messages, "steering-transcript"));
	const items = resultValue(transcript, "items") as readonly Record<string, unknown>[];
	assert.deepEqual(items.filter((item) => item.type === "user").map((item) => item.text), [
		"Inspect README.md",
		"Also inspect package.json",
		"Finish without another tool",
		"Run this as the next turn",
	]);

	writeRequest(backend, "shutdown-steering", "shutdown", {});
	assert.equal(await backend.completion, 0);
});

test("Node backend restores and resolves a durable clarification without a new turn", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-clarification-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	const requestBodies: Record<string, unknown>[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			const payload = JSON.parse(body) as Record<string, unknown>;
			response.writeHead(200, { "content-type": "text/event-stream" });
			requestBodies.push(payload);
			if (requestBodies.length === 1) {
				response.write(`data: ${JSON.stringify({
					type: "response.output_item.done",
					item: {
						type: "function_call",
						call_id: "call-question",
						name: "AskUserQuestion",
						arguments: JSON.stringify({
							question: "Which runtime?",
							options: [{ label: "Node" }, { label: "Python" }],
							header: "Runtime",
							multi_select: false,
						}),
					},
				})}\n\n`);
				response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-question\"}}\n\n");
			} else {
				response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Node selected.\"}\n\n");
				response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-final\"}}\n\n");
			}
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const options = {
		cwd: workspace,
		args: ["--session", "clarification-session", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	} as const;

	const first = await startNodeBackend(options);
	const firstMessages: Array<Record<string, unknown>> = [];
	createInterface({ input: first.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		firstMessages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(firstMessages, "runtime.ready"));
	writeRequest(first, "submit", "turn.submit", {
		message: "Ask before choosing a runtime.",
		client_turn_id: "clarification-client-turn",
		client_user_message_id: "clarification-user-message",
	});
	const liveRequest = await waitFor(() => event(firstMessages, "clarify.request"));
	assert.equal(paramValue(liveRequest, "request_id"), "call-question");
	assert.equal(paramValue(liveRequest, "question"), "Which runtime?");
	await waitFor(() => firstMessages.find((message) =>
		message.method === "status.update" && paramValue(message, "state") === "waiting_clarification"));
	writeRequest(first, "shutdown-first", "shutdown", {});
	assert.equal(await first.completion, 0);
	const waitingSnapshot = JSON.parse(await readFile(
		join(home, ".mycli", "sessions", "clarification-session", "session.json"),
		"utf8",
	)) as Record<string, unknown>;
	assert.equal(waitingSnapshot.state, "waiting_clarification");

	const second = await startNodeBackend(options);
	const secondMessages: Array<Record<string, unknown>> = [];
	createInterface({ input: second.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		secondMessages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(secondMessages, "runtime.ready"));
	writeRequest(second, "bootstrap", "session.bootstrap", { protocol_version: 1 });
	const restored = await waitFor(() => event(secondMessages, "clarify.request"));
	assert.equal(paramValue(restored, "request_id"), "call-question");
	writeRequest(second, "answer", "clarify.respond", {
		request_id: "call-question",
		response: "Node",
	});
	const accepted = await waitFor(() => response(secondMessages, "answer"));
	assert.equal(resultValue(accepted, "accepted"), true);
	const final = await waitFor(() => secondMessages.find((message) =>
		message.method === "message.complete"
		&& paramValue(message, "final") === true), 5_000);
	assert.equal(paramValue(final, "text"), "Node selected.");
	assert.equal(requestBodies.length, 2);
	assert.equal(JSON.stringify(requestBodies[1]?.input).includes("User response: Node"), true);

	writeRequest(second, "shutdown-second", "shutdown", {});
	assert.equal(await second.completion, 0);
	const reopened = new SQLiteSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		assert.equal(reopened.loadState("clarification-session", "suspended_turn"), undefined);
		assert.equal(reopened.loadTurn("clarification-session", "clarification-client-turn")?.status, "completed");
	} finally {
		reopened.close();
	}
});

test("Node backend composes skills subagents and bounded resource discovery", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-integrations-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([
		mkdir(home),
		mkdir(join(workspace, ".mycli", "skills"), { recursive: true }),
	]);
	await writeFile(join(workspace, ".mycli", "skills", "review.md"), [
		"---",
		"name: review",
		"description: Review repository changes",
		"---",
		"PRIVATE SKILL BODY THAT MUST NOT CROSS RESOURCE LIST",
	].join("\n"), "utf8");
	t.after(async () => { await rm(root, { recursive: true, force: true }); });

	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "integration-surfaces", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: "http://127.0.0.1:9/v1",
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));

	writeRequest(backend, "manifest", "extension.manifest", {});
	const manifestResponse = await waitFor(() => response(messages, "manifest"));
	const manifest = resultValue(manifestResponse, "tool_manifest") as {
		readonly tools: readonly { readonly name: string }[];
	};
	assert.deepEqual(manifest.tools.slice(-9).map((tool) => tool.name), [
		"BashOutput",
		"KillShell",
		"Skill",
		"spawn_agent",
		"send_message",
		"followup_task",
		"interrupt_agent",
		"list_agents",
		"wait_agent",
	]);

	writeRequest(backend, "resources", "resource.list", {});
	const resourceResponse = await waitFor(() => response(messages, "resources"));
	const resources = resultValue(resourceResponse, "resources") as readonly Record<string, unknown>[];
	assert.equal(resources.some((resource) => resource.id === "skill:review"), true);
	assert.equal(JSON.stringify(resources).includes("PRIVATE SKILL BODY"), false);

	writeRequest(backend, "shutdown-integrations", "shutdown", {});
	assert.equal(await backend.completion, 0);
});

test("Node backend runs a spawned subagent through the shared Node runtime", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-child-runtime-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	const parentRequests: Record<string, unknown>[] = [];
	const childRequests: Record<string, unknown>[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
				const payload = JSON.parse(body) as Record<string, unknown>;
				response.writeHead(200, { "content-type": "text/event-stream" });
				if (isSubagentRequest(payload)) {
					childRequests.push(payload);
					response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Child inspected repository.\"}\n\n");
					response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-child\",\"usage\":{\"input_tokens\":3,\"output_tokens\":4}}}\n\n");
				} else if (parentRequests.push(payload) === 1) {
				response.write(`data: ${JSON.stringify({
					type: "response.output_item.done",
					item: {
						type: "function_call",
						call_id: "call-spawn-1",
						name: "spawn_agent",
						arguments: JSON.stringify({
							task_name: "explore",
							message: "Inspect the repository.",
						}),
					},
				})}\n\n`);
				response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-parent-tools\"}}\n\n");
			} else {
				response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Parent received child report.\"}\n\n");
				response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-parent-final\"}}\n\n");
			}
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");

	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "parent-session", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	writeRequest(backend, "child-turn", "turn.submit", {
		message: "Use a subagent.",
		client_turn_id: "parent-client-turn",
		client_user_message_id: "parent-user-message",
	});
	let final: Record<string, unknown>;
	try {
		final = await waitFor(() => messages.find((message) => {
			if (message.method !== "message.complete") return false;
			const params = message.params as Record<string, unknown> | undefined;
			return params?.final === true && params.text === "Parent received child report.";
		}), 5_000);
	} catch {
		assert.fail(JSON.stringify({
				requests: [...parentRequests, ...childRequests].map((body) => ({
				tools: toolNames(body.tools),
				input: body.input,
			})),
			events: messages.filter((message) => typeof message.method === "string").map(
				(message) => ({ method: message.method, params: message.params }),
			),
		}, null, 2));
	}
	assert.ok(final);
	await waitFor(() => messages.find((message) => (
		message.method === "subagent.updated"
		&& (message.params as { subagent?: { status?: string } } | undefined)?.subagent?.status === "completed"
	)));
	assert.equal(parentRequests.length, 2);
	assert.equal(childRequests.length, 1);
	assert.deepEqual(toolNames(childRequests[0]?.tools), [
		"Read", "Edit", "Patch", "Write", "AskUserQuestion", "update_plan", "web_fetch",
		"tool_search", "Skill",
	]);
	assert.equal(childRequests[0]?.model, "gpt-test");
	assert.match(String(childRequests[0]?.instructions), /^# Identity\n/u);
	assert.match(String(childRequests[0]?.instructions), /until their goal is genuinely handled/u);
	const childInput = childRequests[0]?.input as readonly Record<string, unknown>[];
	const childDeveloperContext = childInput.filter((item) => item.role === "developer")
		.map((item) => String(item.content)).join("\n");
	assert.match(childDeveloperContext, /Agent path: \/root\/explore/u);
	assert.match(childDeveloperContext, /Assigned task: explore/u);
	assert.match(
		childDeveloperContext,
		/Tool scope: AskUserQuestion, Edit, Patch, Read, Skill, Write, tool_search, update_plan, web_fetch/u,
	);
	assert.match(childDeveloperContext, /Permission profile: workspace/u);
	assert.match(childDeveloperContext, /Sandbox mode: workspace-write/u);
	assert.deepEqual(childInput.at(-1), { role: "user", content: "Inspect the repository." });
	const subagentEvents = messages.filter((message) => message.method === "subagent.updated");
	assert.deepEqual(subagentEvents.map((message) => (
		(message.params as { subagent: { status: string } }).subagent.status
	)), ["running", "completed"]);
	assert.equal(JSON.stringify(subagentEvents).includes("Child inspected repository"), false);

	writeRequest(backend, "shutdown-child", "shutdown", {});
	assert.equal(await backend.completion, 0);
	const store = new SQLiteSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		const tasks = store.subagentTasks.list("parent-session");
		assert.equal(tasks.length, 1);
		assert.equal(tasks[0]?.status, "completed");
		assert.notEqual(tasks[0]?.parentTurnId, "parent-turn-unavailable");
		assert.equal(tasks[0]?.payload.report, "Child inspected repository.");
		const agents = store.agentThreads.list({ rootThreadId: "parent-session" });
		assert.equal(agents.length, 1);
		assert.equal(agents[0]?.spawnConfig?.provider.model, "gpt-test");
		assert.equal(agents[0]?.spawnConfig?.environment.MYCLI_API_KEY, undefined);
		assert.equal(JSON.stringify(agents[0]?.spawnConfig).includes("test-key"), false);
		assert.equal(agents[0]?.spawnConfig?.instructions.role, undefined);
		const childSessionId = tasks[0]?.childSessionId;
		assert.ok(childSessionId);
		const parentInstructions = store.modelInputLedger.loadLatestInstructionSnapshot("parent-session");
		const childInstructions = store.modelInputLedger.loadLatestInstructionSnapshot(childSessionId);
		assert.equal(childInstructions?.contentSha256, parentInstructions?.contentSha256);
		const childManifest = store.modelInputLedger.loadLatestProviderRequestManifest(childSessionId);
		assert.ok(childManifest);
		assert.deepEqual(
			store.modelInputLedger.reconstructProviderStep(childManifest.requestId).request.model,
			"gpt-test",
		);
		assert.equal(store.modelInputLedger.loadModelContextEvents(childSessionId).some((item) => (
			item.fragment?.kind === "subagent_context"
		)), true);
	} finally {
		store.close();
	}
});

test("Node backend approves a child Shell sandbox escalation and resumes the same child session", {
	timeout: 15_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-child-approval-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	await writeFile(
		join(workspace, "child-command.cjs"),
		"process.stdout.write('child-approved\\n');\n",
		"utf8",
	);
	const command = `"${process.execPath}" child-command.cjs`;
	const parentRequests: Record<string, unknown>[] = [];
	const childRequests: Record<string, unknown>[] = [];
	let releaseParentFinal!: () => void;
	const parentFinalReleased = new Promise<void>((resolve) => {
		releaseParentFinal = resolve;
	});
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			const payload = JSON.parse(body) as Record<string, unknown>;
			response.writeHead(200, { "content-type": "text/event-stream" });
			if (isSubagentRequest(payload)) {
				childRequests.push(payload);
				if (childRequests.length === 1) {
					response.write(`data: ${JSON.stringify({
						type: "response.output_item.done",
						item: {
							type: "function_call",
							call_id: "call-child-shell",
							name: "Shell",
							arguments: JSON.stringify({
								command,
								yield_time_ms: 3_000,
								sandbox_permissions: "require_escalated",
							}),
						},
					})}\n\n`);
					response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-child-shell\"}}\n\n");
					response.end("data: [DONE]\n\n");
					return;
				}
				response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Child completed after approval.\"}\n\n");
				response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-child-approved\"}}\n\n");
				response.end("data: [DONE]\n\n");
				return;
			}

			parentRequests.push(payload);
			if (parentRequests.length === 1) {
				response.write(`data: ${JSON.stringify({
					type: "response.output_item.done",
					item: {
						type: "function_call",
						call_id: "call-spawn-approved-child",
						name: "spawn_agent",
						arguments: JSON.stringify({
							task_name: "approval-worker",
							message: "Run the command and report after approval.",
						}),
					},
				})}\n\n`);
				response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-parent-spawn\"}}\n\n");
				response.end("data: [DONE]\n\n");
				return;
			}
			void parentFinalReleased.then(() => {
				response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Parent observed child completion.\"}\n\n");
				response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-parent-approved-final\"}}\n\n");
				response.end("data: [DONE]\n\n");
			});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "child-approval-parent", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	let closed = false;
	const shutdown = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		writeRequest(backend, "shutdown-child-approval", "shutdown", {});
		assert.equal(await backend.completion, 0);
	};
	t.after(async () => {
		releaseParentFinal();
		await shutdown();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		});
		await rm(root, { recursive: true, force: true });
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	writeRequest(backend, "trust-child-approval", "workspace.trust.set", { state: "trusted" });
	await waitFor(() => response(messages, "trust-child-approval"));
	writeRequest(backend, "permission-child-approval", "permissions.update", { profile: "workspace" });
	await waitFor(() => response(messages, "permission-child-approval"));
	writeRequest(backend, "start-child-approval", "turn.submit", {
		message: "Delegate the command to a child.",
		client_turn_id: "child-approval-parent-turn",
		client_user_message_id: "child-approval-parent-message",
	});

	const approval = await waitFor(() => messages.find((message) => (
		message.method === "approval.request"
		&& paramValue(message, "session_id") !== "child-approval-parent"
	)));
	const childSessionId = paramValue(approval, "session_id");
	const generation = paramValue(approval, "generation");
	const decisionId = paramValue(approval, "decision_id");
	assert.equal(typeof childSessionId, "string");
	assert.equal(paramValue(approval, "child_session_id"), childSessionId);
	assert.equal(typeof generation, "number");
	assert.equal(decisionId, "call-child-shell");
	await waitFor(() => messages.find((message) => (
		message.method === "subagent.updated"
		&& (paramValue(message, "subagent") as Record<string, unknown> | undefined)?.status === "waiting"
	)));
	assert.equal(messages.some((message) => (
		message.method === "subagent.updated"
		&& ["completed", "failed", "interrupted"].includes(
			String((paramValue(message, "subagent") as Record<string, unknown> | undefined)?.status),
		)
	)), false);
	const waitingStore = new SQLiteSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		const task = waitingStore.subagentTasks.list("child-approval-parent")[0];
		assert.equal(task?.childSessionId, childSessionId);
		assert.equal(task?.status, "running");
		assert.equal(waitingStore.agentThreads.get(String(childSessionId))?.status, "waiting");
	} finally {
		waitingStore.close();
	}

	writeRequest(backend, "approve-child", "approval.respond", {
		session_id: childSessionId,
		generation,
		decision_id: decisionId,
		choice: "approve_once",
	});
	const accepted = await waitFor(() => response(messages, "approve-child"));
	assert.equal(resultValue(accepted, "accepted"), true);
	assert.equal(resultValue(accepted, "session_id"), childSessionId);
	await waitFor(() => messages.find((message) => (
		message.method === "subagent.updated"
		&& (paramValue(message, "subagent") as Record<string, unknown> | undefined)?.status === "completed"
	)), 8_000);
	assert.equal(childRequests.length, 2);
	assert.match(JSON.stringify(childRequests[1]?.input), /child-approved/u);
	assert.equal(messages.some((message) => (
		message.method === "approval.respond"
		&& paramValue(message, "session_id") === childSessionId
		&& paramValue(message, "generation") === generation
	)), true);

	releaseParentFinal();
	const final = await waitFor(() => messages.find((message) => (
		message.method === "message.complete"
		&& paramValue(message, "final") === true
		&& paramValue(message, "text") === "Parent observed child completion."
	)), 5_000);
	assert.ok(final);
	assert.equal(parentRequests.length, 2);
	await shutdown();
	const completedStore = new SQLiteSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		const task = completedStore.subagentTasks.list("child-approval-parent")[0];
		assert.equal(task?.status, "completed");
		assert.equal(task?.payload.report, "Child completed after approval.");
	} finally {
		completedStore.close();
	}
});

test("Node backend gives a Full Access child the frozen parent policy without approval", {
	timeout: 15_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-full-access-child-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	await writeFile(
		join(workspace, "child-full-access.cjs"),
		"process.stdout.write('child-full-access-ok\\n');\n",
		"utf8",
	);
	const command = `"${process.execPath}" child-full-access.cjs`;
	const parentRequests: Record<string, unknown>[] = [];
	const childRequests: Record<string, unknown>[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			const payload = JSON.parse(body) as Record<string, unknown>;
			response.writeHead(200, { "content-type": "text/event-stream" });
			if (isSubagentRequest(payload)) {
				childRequests.push(payload);
				if (childRequests.length === 1) {
					response.write(`data: ${JSON.stringify({
						type: "response.output_item.done",
						item: {
							type: "function_call",
							call_id: "call-child-full-access-shell",
							name: "Shell",
							arguments: JSON.stringify({ command, yield_time_ms: 3_000 }),
						},
					})}\n\n`);
					response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-child-full-access-shell\"}}\n\n");
					response.end("data: [DONE]\n\n");
					return;
				}
				response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Full Access child completed.\"}\n\n");
				response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-child-full-access-completed\"}}\n\n");
				response.end("data: [DONE]\n\n");
				return;
			}

			parentRequests.push(payload);
			if (parentRequests.length === 1) {
				response.write(`data: ${JSON.stringify({
					type: "response.output_item.done",
					item: {
						type: "function_call",
						call_id: "call-spawn-full-access-child",
						name: "spawn_agent",
						arguments: JSON.stringify({
							task_name: "full-access-worker",
							message: "Run the command and report the output.",
						}),
					},
				})}\n\n`);
				response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-parent-spawn-full-access\"}}\n\n");
				response.end("data: [DONE]\n\n");
				return;
			}
			response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Parent delegated Full Access work.\"}\n\n");
			response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-parent-full-access-completed\"}}\n\n");
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "full-access-child-parent", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	let closed = false;
	const shutdown = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		writeRequest(backend, "shutdown-full-access-child", "shutdown", {});
		assert.equal(await backend.completion, 0);
	};
	t.after(async () => {
		await shutdown();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		});
		await rm(root, { recursive: true, force: true });
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	writeRequest(backend, "trust-full-access-child", "workspace.trust.set", { state: "trusted" });
	await waitFor(() => response(messages, "trust-full-access-child"));
	writeRequest(backend, "permission-full-access-child", "permissions.update", {
		profile: "full-access",
	});
	await waitFor(() => response(messages, "permission-full-access-child"));
	writeRequest(backend, "start-full-access-child", "turn.submit", {
		message: "Delegate the command to a child.",
		client_turn_id: "full-access-child-parent-turn",
		client_user_message_id: "full-access-child-parent-message",
	});

	await waitFor(() => messages.find((message) => (
		message.method === "subagent.updated"
		&& (paramValue(message, "subagent") as Record<string, unknown> | undefined)?.status === "completed"
	)), 8_000);
	assert.equal(messages.some((message) => message.method === "approval.request"), false);
	assert.equal(childRequests.length, 2);
	assert.match(JSON.stringify(childRequests[1]?.input), /child-full-access-ok/u);
	const store = new SQLiteSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		const task = store.subagentTasks.list("full-access-child-parent")[0];
		assert.equal(task?.status, "completed");
		const child = task ? store.agentThreads.get(task.childSessionId) : undefined;
		assert.deepEqual(child?.spawnConfig?.executionPolicy, {
			trusted: true,
			permission: "full-access",
			sandboxMode: "danger-full-access",
			filesystem: "unrestricted",
			network: "enabled",
			writableRoots: [await realpath(workspace)],
		});
	} finally {
		store.close();
	}
	await shutdown();
});

test("Node backend delivers background subagent completion through wait_agent without polling", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-background-child-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	const parentRequests: Record<string, unknown>[] = [];
	const childRequests: Record<string, unknown>[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			const payload = JSON.parse(body) as Record<string, unknown>;
			response.writeHead(200, { "content-type": "text/event-stream" });
			if (isSubagentRequest(payload)) {
				childRequests.push(payload);
				response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Background child report.\"}\n\n");
				response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-background-child\"}}\n\n");
			} else {
				parentRequests.push(payload);
				if (parentRequests.length === 1) {
					response.write(`data: ${JSON.stringify({
						type: "response.output_item.done",
						item: {
							type: "function_call",
							call_id: "call-background-task",
							name: "spawn_agent",
							arguments: JSON.stringify({
								task_name: "inspect",
								message: "Inspect in the background.",
							}),
						},
					})}\n\n`);
					response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-background-task\"}}\n\n");
				} else if (parentRequests.length === 2) {
					response.write(`data: ${JSON.stringify({
						type: "response.output_item.done",
						item: {
							type: "function_call",
							call_id: "call-wait-agent",
							name: "wait_agent",
							arguments: JSON.stringify({ timeout_ms: 5_000 }),
						},
					})}\n\n`);
					response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-wait-agent\"}}\n\n");
				} else {
					response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Parent received automatic background result.\"}\n\n");
					response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-background-parent-final\"}}\n\n");
				}
			}
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");

	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "background-parent", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	writeRequest(backend, "background-turn", "turn.submit", {
		message: "Run a background subagent and wait for it.",
		client_turn_id: "background-parent-turn",
		client_user_message_id: "background-parent-message",
	});
	await waitFor(() => messages.find((message) => (
		message.method === "message.complete"
		&& paramValue(message, "final") === true
		&& paramValue(message, "text") === "Parent received automatic background result."
	)), 7_000);

	assert.equal(parentRequests.length, 3);
	assert.equal(childRequests.length, 1);
	assert.equal(toolNames(parentRequests[0]?.tools).includes("wait_agent"), true);
	assert.equal(toolNames(parentRequests[0]?.tools).includes("SubagentOutput"), false);
	assert.match(JSON.stringify(parentRequests[2]?.input), /<agent-mailbox>/u);
	assert.match(JSON.stringify(parentRequests[2]?.input), /Background child report\./u);
	assert.match(JSON.stringify(parentRequests[2]?.input), /subagent-task:[a-f0-9-]+/u);
	const executedTools = messages
		.filter((message) => message.method === "tool.start")
		.map((message) => paramValue(message, "name"));
	assert.deepEqual(executedTools, ["spawn_agent", "wait_agent"]);
	assert.equal(executedTools.includes("SubagentOutput"), false);
	assert.equal(executedTools.includes("WriteStdin"), false);

	writeRequest(backend, "shutdown-background", "shutdown", {});
	assert.equal(await backend.completion, 0);
	const store = new SQLiteSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		const notifications = store.loadHistoryItems("background-parent").filter((item) => (
			(item.metadata as Readonly<Record<string, unknown>> | undefined)?.source
				=== "agent_mailbox"
		));
		assert.equal(notifications.length, 1);
		const parent = store.loadSession("background-parent");
		assert.ok(parent);
		const mailboxItems = store.agentMailbox.list({ receiverThreadId: parent.threadId });
		assert.equal(mailboxItems.length, 1);
		assert.equal(mailboxItems[0]?.payload.kind, "completion");
		assert.equal(mailboxItems[0]?.state, "committed");
		const task = store.subagentTasks.list("background-parent")[0];
		assert.ok(task);
		const parentDir = join(home, ".mycli", "sessions", "background-parent");
		const outputPath = join(parentDir, "tasks", task.childSessionId, "output.txt");
			assert.equal(await readFile(outputPath, "utf8"), "Background child report.");
			const runId = subagentRunId(task.childSessionId);
			const childSnapshot = JSON.parse(await readFile(
				join(parentDir, "subagents", `${runId}.json`),
				"utf8",
			)) as Record<string, unknown>;
			const thread = store.agentThreads.get(task.childSessionId);
			assert.equal(childSnapshot.child_session_id, task.childSessionId);
			assert.equal(childSnapshot.thread_id, task.childSessionId);
			assert.equal(childSnapshot.root_thread_id, "background-parent");
			assert.equal(childSnapshot.parent_thread_id, "background-parent");
			assert.equal(childSnapshot.agent_path, thread?.path);
			assert.equal(childSnapshot.task_name, thread?.taskName);
		assert.equal(childSnapshot.mode, "background");
		assert.equal(childSnapshot.description, "Inspect in the background.");
		assert.equal(childSnapshot.report, "Background child report.");
		assert.ok(Array.isArray(childSnapshot.messages));
		const parentSnapshot = JSON.parse(await readFile(
			join(parentDir, "session.json"),
			"utf8",
		)) as Record<string, unknown>;
		assert.equal((parentSnapshot.links as Record<string, unknown>).events, "events.jsonl");
		assert.equal(
			((parentSnapshot.subagents as Array<Record<string, unknown>>)[0]?.path),
			`subagents/${runId}.json`,
			);
			const parentEvents = await jsonLines(join(parentDir, "events.jsonl"));
			assert.ok(parentEvents.some((row) => row.type === "conversation.saved"));
			assert.ok(parentEvents.some((row) => row.type === "subagent.updated"));
			assert.ok(parentEvents.some((row) => row.type === "agent.lifecycle"));
			assert.ok(parentEvents.some((row) => row.type === "agent.communication"));
			assert.equal(
				parentEvents.filter((row) => row.type === "agent.communication")
					.some((row) => JSON.stringify(row).includes("Background child report.")),
				false,
			);
			assert.equal(
				await readFile(join(
					home,
					".mycli",
					"sessions",
					task.childSessionId,
					"tasks",
					task.taskId,
					"output.txt",
				), "utf8"),
				"Background child report.",
			);
			const childEvents = await jsonLines(join(
				home,
				".mycli",
				"sessions",
				task.childSessionId,
				"events.jsonl",
			));
			assert.ok(childEvents.some((row) => row.type === "conversation.saved"));
			assert.ok(childEvents.some((row) => row.type === "agent.lifecycle"));
			assert.ok(childEvents.some((row) => row.type === "agent.usage"));
	} finally {
		store.close();
	}
});

test("Node backend triggers a durable follow-up turn without fabricating child user input", {
	timeout: 15_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-agent-follow-up-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	const parentRequests: Record<string, unknown>[] = [];
	const childRequests: Record<string, unknown>[] = [];
	let releaseSecondChild = false;
	let completeSecondChild: (() => void) | undefined;
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			const payload = JSON.parse(body) as Record<string, unknown>;
			response.writeHead(200, { "content-type": "text/event-stream" });
			const finishText = (text: string, responseId: string): void => {
				response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`);
				response.write(`data: ${JSON.stringify({
					type: "response.completed",
					response: { id: responseId },
				})}\n\n`);
				response.end("data: [DONE]\n\n");
			};
			const finishTool = (callId: string, name: string, args: Record<string, unknown>): void => {
				response.write(`data: ${JSON.stringify({
					type: "response.output_item.done",
					item: {
						type: "function_call",
						call_id: callId,
						name,
						arguments: JSON.stringify(args),
					},
				})}\n\n`);
				response.write(`data: ${JSON.stringify({
					type: "response.completed",
					response: { id: `resp-${callId}` },
				})}\n\n`);
				response.end("data: [DONE]\n\n");
			};
			if (isSubagentRequest(payload)) {
				childRequests.push(payload);
				if (childRequests.length === 1) {
					finishText("Initial agent report.", "resp-agent-initial");
					return;
				}
				completeSecondChild = () => finishText("Follow-up agent report.", "resp-agent-follow-up");
				if (releaseSecondChild) completeSecondChild();
				return;
			}

			parentRequests.push(payload);
			if (parentRequests.length === 1) {
				finishTool("call-spawn-worker", "spawn_agent", {
					task_name: "worker",
					message: "Inspect the repository.",
				});
				return;
			}
			if (parentRequests.length === 2) {
				finishTool("call-follow-worker", "followup_task", {
					target: "worker",
					message: "Resume with the focused follow-up.",
				});
				return;
			}
			if (parentRequests.length === 3) {
				finishTool("call-wait-worker", "wait_agent", { timeout_ms: 5_000 });
				releaseSecondChild = true;
				setImmediate(() => { completeSecondChild?.(); });
				return;
			}
			if (parentRequests.length === 4) {
				finishTool("call-wait-worker-completion", "wait_agent", { timeout_ms: 5_000 });
				return;
			}
			finishText("Follow-up completed and received.", "resp-parent-follow-up-final");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");

	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "follow-up-parent", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	writeRequest(backend, "follow-up-turn", "turn.submit", {
		message: "Spawn the worker and send a follow-up.",
		client_turn_id: "follow-up-parent-turn",
		client_user_message_id: "follow-up-parent-message",
	});
	await waitFor(() => messages.find((message) => (
		message.method === "message.complete"
		&& paramValue(message, "final") === true
		&& paramValue(message, "text") === "Follow-up completed and received."
	)), 10_000);

	assert.equal(parentRequests.length, 5);
	assert.equal(childRequests.length, 2);
	assert.match(JSON.stringify(childRequests[1]?.input), /<agent-mailbox>/u);
	assert.match(JSON.stringify(childRequests[1]?.input), /Resume with the focused follow-up\./u);
	const executedTools = messages
		.filter((message) => message.method === "tool.start")
		.map((message) => paramValue(message, "name"));
	assert.deepEqual(executedTools, [
		"spawn_agent",
		"followup_task",
		"wait_agent",
		"wait_agent",
	]);
	const projectedAgents = messages.filter((message) => message.method === "subagent.updated")
		.map((message) => (message.params as {
			subagent: { thread_id: string; run_id: string; status: string };
		}).subagent);
	assert.deepEqual(projectedAgents.map((agent) => agent.status), [
		"running",
		"completed",
		"running",
		"completed",
	]);
	assert.equal(new Set(projectedAgents.map((agent) => agent.thread_id)).size, 1);
	assert.equal(new Set(projectedAgents.map((agent) => agent.run_id)).size, 1);
	const liveStore = new SQLiteSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		const liveTask = liveStore.subagentTasks.list("follow-up-parent")[0];
		assert.ok(liveTask);
		assert.deepEqual(liveStore.agentThreads.loadLease(liveTask.childSessionId)?.checkpoint, {
			kind: "idle",
			committed: true,
		});
	} finally {
		liveStore.close();
	}

	writeRequest(backend, "shutdown-follow-up", "shutdown", {});
	assert.equal(await backend.completion, 0);
	const store = new SQLiteSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		const tasks = store.subagentTasks.list("follow-up-parent");
		assert.equal(tasks.length, 2);
		assert.deepEqual(tasks.map((task) => task.payload.report), [
			"Follow-up agent report.",
			"Initial agent report.",
		]);
		const childSessionId = tasks[0]!.childSessionId;
		assert.equal(store.agentThreads.loadLease(childSessionId), undefined);
		const childHistory = store.loadHistoryItems(childSessionId);
		assert.equal(childHistory.filter((item) => (
			item.type === "user_message"
			&& (item.metadata as Readonly<Record<string, unknown>> | undefined)?.source === "submit"
		)).length, 1);
		assert.equal(childHistory.some((item) => item.type === "user_message" && item.text === ""), false);
		assert.equal(childHistory.filter((item) => (
			(item.metadata as Readonly<Record<string, unknown>> | undefined)?.source === "agent_mailbox"
		)).length, 1);
		const parent = store.loadSession("follow-up-parent");
		assert.ok(parent);
		assert.equal(store.agentMailbox.list({ receiverThreadId: parent.threadId }).filter(
			(item) => item.payload.kind === "completion" && item.state === "committed",
		).length, 2);
		assert.equal(store.agentMailbox.list({ receiverThreadId: childSessionId }).filter(
			(item) => item.payload.kind === "message" && item.state === "committed",
		).length, 1);
	} finally {
		store.close();
	}
});

test("Node backend recovers a stale agent and accepts an explicit follow-up after restart", {
	timeout: 15_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-agent-restart-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	const dbPath = join(home, ".mycli", "sessions.db");
	const seed = new SQLiteSessionStore({ dbPath });
	seedCompletedSession(seed, workspace, "agent-restart-parent", "Seed parent", "Seeded");
	const parent = seed.loadSession("agent-restart-parent");
	assert.ok(parent);
	seed.agentThreads.reserve({
		threadId: "recoverable-agent-child",
		rootThreadId: parent.threadId,
		parentThreadId: parent.threadId,
		parentPath: rootAgentPath(),
		taskName: "worker",
		profileId: "subagent",
		spawnConfig: {
			workspaceRoot: workspace,
			cwd: workspace,
			environment: {},
			executionPolicy: {
				trusted: true,
				permission: "workspace",
				sandboxMode: "workspace-write",
				filesystem: "workspace_write",
				network: "disabled",
				writableRoots: [workspace],
			},
			provider: { provider: "openai", protocol: "responses", model: "gpt-test" },
			instructions: { project: "You are mycli.", role: "Inspect files." },
			tools: ["Read"],
			forkTurns: "none",
		},
	});
	seed.forkAgentConversation({
		sourceSessionId: "agent-restart-parent",
		targetSessionId: "recoverable-agent-child",
		workspaceRoot: workspace,
		targetThreadId: "recoverable-agent-child",
		forkTurns: "none",
	});
	seed.agentThreads.transition({ threadId: "recoverable-agent-child", status: "running" });
	seed.subagentTasks.reserve({
		taskId: "stale-agent-task",
		parentSessionId: "agent-restart-parent",
		parentTurnId: "stale-parent-turn",
		childSessionId: "recoverable-agent-child",
		profileId: "subagent",
		mode: "background",
		description: "Stale work",
	});
	seed.subagentTasks.markRunning({
		taskId: "stale-agent-task",
		parentSessionId: "agent-restart-parent",
		childSessionId: "recoverable-agent-child",
	});
	seed.agentThreads.saveLease({
		threadId: "recoverable-agent-child",
		generation: "dead-generation",
		ownerId: "dead-agent-owner",
		ownerPid: 2_147_483_647,
		checkpoint: {
			kind: "tool_call",
			committed: false,
			turnId: "stale-child-turn",
			callId: "stale-write-call",
			mutating: true,
		},
	});
	seed.close();

	const parentRequests: Record<string, unknown>[] = [];
	const childRequests: Record<string, unknown>[] = [];
	let releaseChild = false;
	let completeChild: (() => void) | undefined;
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			const payload = JSON.parse(body) as Record<string, unknown>;
			const tools = toolNames(payload.tools);
			response.writeHead(200, { "content-type": "text/event-stream" });
			const completeText = (text: string, id: string): void => {
				response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`);
				response.write(`data: ${JSON.stringify({ type: "response.completed", response: { id } })}\n\n`);
				response.end("data: [DONE]\n\n");
			};
			const completeTool = (callId: string, name: string, args: Record<string, unknown>): void => {
				response.write(`data: ${JSON.stringify({
					type: "response.output_item.done",
					item: {
						type: "function_call",
						call_id: callId,
						name,
						arguments: JSON.stringify(args),
					},
				})}\n\n`);
				response.write(`data: ${JSON.stringify({
					type: "response.completed",
					response: { id: `resp-${callId}` },
				})}\n\n`);
				response.end("data: [DONE]\n\n");
			};
			if (tools.length === 1 && tools[0] === "Read") {
				childRequests.push(payload);
				completeChild = () => completeText("Recovered child report.", "resp-recovered-child");
				if (releaseChild) completeChild();
				return;
			}
			parentRequests.push(payload);
			const input = JSON.stringify(payload.input);
			if (parentRequests.length === 1) {
				completeTool("call-recover-agent", "followup_task", {
					target: "worker",
					message: "Continue from the safe checkpoint.",
				});
				return;
			}
			if (!input.includes("Recovered child report.")) {
				completeTool(`call-wait-recovery-${parentRequests.length}`, "wait_agent", {
					timeout_ms: 5_000,
				});
				releaseChild = true;
				setImmediate(() => { completeChild?.(); });
				return;
			}
			completeText("Recovered follow-up received.", "resp-recovery-parent-final");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "agent-restart-parent", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	writeRequest(backend, "agent-restart-turn", "turn.submit", {
		message: "Recover the interrupted worker.",
		client_turn_id: "agent-restart-client-turn",
		client_user_message_id: "agent-restart-user-message",
	});
	await waitFor(() => messages.find((message) => (
		message.method === "message.complete"
		&& paramValue(message, "final") === true
		&& paramValue(message, "text") === "Recovered follow-up received."
	)), 10_000);

	assert.match(JSON.stringify(parentRequests[0]?.input), /agent runtime owner unavailable after restart/u);
	assert.equal(childRequests.length, 1);
	assert.match(JSON.stringify(childRequests[0]?.input), /Continue from the safe checkpoint\./u);
	writeRequest(backend, "shutdown-agent-restart", "shutdown", {});
	assert.equal(await backend.completion, 0);
	const reopened = new SQLiteSessionStore({ dbPath });
	try {
		const tasks = reopened.subagentTasks.list("agent-restart-parent");
		assert.deepEqual(tasks.map((task) => task.status), ["completed", "interrupted"]);
		assert.equal(tasks[0]?.payload.report, "Recovered child report.");
		assert.equal(reopened.agentThreads.get("recoverable-agent-child")?.status, "unloaded");
		assert.equal(reopened.agentThreads.loadLease("recoverable-agent-child"), undefined);
		assert.equal(reopened.agentMailbox.list({ receiverThreadId: parent.threadId }).filter(
			(item) => item.payload.kind === "completion" && item.state === "committed",
		).length, 2);
	} finally {
		reopened.close();
	}
});

test("Node backend repairs a terminal subagent notification and does not duplicate it after restart", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-subagent-recovery-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	const dbPath = join(home, ".mycli", "sessions.db");
	const seed = new SQLiteSessionStore({ dbPath });
	try {
		seedCompletedSession(seed, workspace, "subagent-recovery", "seed question", "seed answer");
		const ownership = {
			taskId: "durable-task",
			parentSessionId: "subagent-recovery",
			childSessionId: "durable-child",
		};
		seed.subagentTasks.reserve({
			...ownership,
			parentTurnId: "seed-turn-subagent-recovery",
			profileId: "subagent",
			mode: "background",
			description: "Recover durable child artifacts.",
		});
		seed.subagentTasks.markRunning(ownership);
		seed.subagentTasks.complete({
			...ownership,
			report: "Recovered durable child report.",
			outputReference: "subagent-task:durable-task",
		});
	} finally {
		seed.close();
	}

	const first = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "subagent-recovery", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: "http://127.0.0.1:9/v1",
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	const firstMessages: Array<Record<string, unknown>> = [];
	createInterface({ input: first.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		firstMessages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(firstMessages, "runtime.ready"));
	writeRequest(first, "shutdown-first-recovery", "shutdown", {});
	assert.equal(await first.completion, 0);
	const recoveryDir = join(home, ".mycli", "sessions", "subagent-recovery");
	const outputPath = join(recoveryDir, "tasks", "durable-child", "output.txt");
	const subagentPath = join(
		recoveryDir,
		"subagents",
		`${subagentRunId("durable-child")}.json`,
	);
	assert.equal(await readFile(outputPath, "utf8"), "Recovered durable child report.");
	await Promise.all([rm(outputPath), rm(subagentPath)]);
	assert.equal(existsSync(outputPath), false);
	assert.equal(existsSync(subagentPath), false);

	const requests: Record<string, unknown>[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			requests.push(JSON.parse(body) as Record<string, unknown>);
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Recovered once.\"}\n\n");
			response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-subagent-recovery\"}}\n\n");
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const second = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "subagent-recovery", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	const secondMessages: Array<Record<string, unknown>> = [];
	createInterface({ input: second.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		secondMessages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(secondMessages, "runtime.ready"));
	assert.equal(await readFile(outputPath, "utf8"), "Recovered durable child report.");
	assert.equal(
		(JSON.parse(await readFile(subagentPath, "utf8")) as Record<string, unknown>).description,
		"Recover durable child artifacts.",
	);
	writeRequest(second, "recovery-turn", "turn.submit", {
		message: "Continue after recovery.",
		client_turn_id: "recovery-client-turn",
		client_user_message_id: "recovery-user-message",
	});
	await waitFor(() => secondMessages.find((message) => (
		message.method === "message.complete"
		&& paramValue(message, "final") === true
		&& paramValue(message, "text") === "Recovered once."
	)), 5_000);
	assert.equal(requests.length, 1);
	const serializedInput = JSON.stringify(requests[0]?.input);
	assert.equal(
		(serializedInput.match(/<task-notification>/gu) ?? []).length,
		1,
	);
	assert.match(serializedInput, /Recovered durable child report\./u);
	assert.match(serializedInput, /<output-file>[^<]+\/tasks\/durable-child\/output\.txt<\/output-file>/u);

	writeRequest(second, "shutdown-second-recovery", "shutdown", {});
	assert.equal(await second.completion, 0);
	const reopened = new SQLiteSessionStore({ dbPath });
	try {
		assert.equal(reopened.loadHistoryItems("subagent-recovery").filter((item) => (
			(item.metadata as Readonly<Record<string, unknown>> | undefined)?.source
				=== "task_notification"
		)).length, 1);
	} finally {
		reopened.close();
	}
});

test("wait_agent wakes for live user steering and commits it before the next provider step", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-wait-steering-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	const requests: Record<string, unknown>[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			requests.push(JSON.parse(body) as Record<string, unknown>);
			response.writeHead(200, { "content-type": "text/event-stream" });
			if (requests.length === 1) {
				response.write(`data: ${JSON.stringify({
					type: "response.output_item.done",
					item: {
						type: "function_call",
						call_id: "call-wait-steering",
						name: "wait_agent",
						arguments: JSON.stringify({ timeout_ms: 5_000 }),
					},
				})}\n\n`);
				response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-wait-steering\"}}\n\n");
			} else {
				response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Steering received after wait.\"}\n\n");
				response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-steering-final\"}}\n\n");
			}
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "wait-steering", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	writeRequest(backend, "wait-turn", "turn.submit", {
		message: "Wait for steering.",
		client_turn_id: "wait-steering-client",
		client_user_message_id: "wait-steering-message",
	});
	const accepted = await waitFor(() => response(messages, "wait-turn"));
	const turnId = resultValue(accepted, "turn_id");
	assert.equal(typeof turnId, "string");
	await waitFor(() => messages.find((message) => (
		message.method === "tool.start" && paramValue(message, "name") === "wait_agent"
	)));
	writeRequest(backend, "steer-wait", "turn.steer", {
		message: "steering while wait_agent is blocked",
		expected_turn_id: turnId,
		client_turn_id: "steer-during-wait",
	});
	await waitFor(() => response(messages, "steer-wait"));
	await waitFor(() => messages.find((message) => (
		message.method === "message.complete"
		&& paramValue(message, "final") === true
		&& paramValue(message, "text") === "Steering received after wait."
	)), 5_000);
	assert.equal(requests.length, 2);
	assert.match(JSON.stringify(requests[1]?.input), /steering while wait_agent is blocked/u);

	writeRequest(backend, "shutdown-wait-steering", "shutdown", {});
	assert.equal(await backend.completion, 0);
});

test("Node backend exposes Shell only on turns accepted after workspace trust", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-shell-policy-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	const requestTools: string[][] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			const payload = JSON.parse(body) as Record<string, unknown>;
			requestTools.push(
				(payload.tools as Array<Record<string, unknown>> | undefined)
					?.map((tool) => String(tool.name)) ?? [],
			);
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"done\"}\n\n");
			response.write(`data: {"type":"response.completed","response":{"id":"resp_${requestTools.length}"}}\n\n`);
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "shell-policy-session", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));

	writeRequest(backend, "turn-untrusted", "turn.submit", {
		message: "first",
		client_turn_id: "turn-untrusted",
		client_user_message_id: "message-untrusted",
	});
	await waitFor(() => finalMessageCount(messages) === 1);
	writeRequest(backend, "trust-shell", "workspace.trust.set", { state: "trusted" });
	await waitFor(() => response(messages, "trust-shell"));
	writeRequest(backend, "permission-shell", "permissions.update", { profile: "read-only" });
	await waitFor(() => response(messages, "permission-shell"));
	writeRequest(backend, "turn-trusted", "turn.submit", {
		message: "second",
		client_turn_id: "turn-trusted",
		client_user_message_id: "message-trusted",
	});
	await waitFor(() => finalMessageCount(messages) === 2);

	assert.deepEqual(requestTools[0], [
		"Read", "Edit", "Patch", "Write", "AskUserQuestion", "update_plan", "web_fetch",
		"tool_search", "Skill",
		"spawn_agent", "send_message", "followup_task", "interrupt_agent", "list_agents",
		"wait_agent",
	]);
	assert.deepEqual(requestTools[1], [
		"Read", "Edit", "Patch", "Write", "AskUserQuestion", "update_plan", "web_fetch",
		"tool_search", "Shell", "WriteStdin", "Skill", "spawn_agent", "send_message",
		"followup_task", "interrupt_agent", "list_agents", "wait_agent",
	]);
	writeRequest(backend, "shutdown-shell-policy", "shutdown", {});
	assert.equal(await backend.completion, 0);
});

test("Node backend persists workspace trust across process restarts", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-trust-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(home);
	await mkdir(workspace);
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	const options = {
		cwd: workspace,
		args: ["--session", "trust-session", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: "http://127.0.0.1:9/v1",
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	} as const;

	const first = await startNodeBackend(options);
	const firstMessages: Array<Record<string, unknown>> = [];
	createInterface({ input: first.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		firstMessages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(firstMessages, "runtime.ready"));
	writeRequest(first, "trust-set", "workspace.trust.set", { state: "trusted" });
	const saved = await waitFor(() => response(firstMessages, "trust-set"));
	assert.deepEqual(saved.result, {
		state: "trusted",
		workspace,
		source: "user_store",
		enforced: true,
	});
	writeRequest(first, "shutdown-first", "shutdown", {});
	assert.equal(await first.completion, 0);

	const second = await startNodeBackend(options);
	const secondMessages: Array<Record<string, unknown>> = [];
	createInterface({ input: second.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		secondMessages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(secondMessages, "runtime.ready"));
	writeRequest(second, "bootstrap", "session.bootstrap", { protocol_version: 1 });
	const bootstrap = await waitFor(() => response(secondMessages, "bootstrap"));
	const status = resultValue(bootstrap, "status") as Record<string, unknown>;
	assert.deepEqual(status.trust, {
		state: "trusted",
		workspace,
		source: "user_store",
		enforced: true,
	});
	writeRequest(second, "shutdown-second", "shutdown", {});
	assert.equal(await second.completion, 0);
});

test("Node backend atomically resumes complete persisted session state", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-resume-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(home);
	await mkdir(workspace);
	const dbPath = join(home, ".mycli", "sessions.db");
	const seed = new SQLiteSessionStore({ dbPath });
	try {
			seedCompletedSession(seed, workspace, "source", "source question", "source answer");
			seedCompletedSession(seed, workspace, "approval", "approval question", "approval answer");
			seedWaitingApproval(seed, workspace, "approval", "call-approval");
			seedCompletedSession(seed, workspace, "target", "target question", "target answer");
		seedCompletedSession(seed, workspace, "invalid", "invalid question", "invalid answer");
		seedCompletedSession(
			seed,
			workspace,
			"invalid-suspended",
			"invalid suspended question",
			"invalid suspended answer",
		);
		seed.saveState({
			sessionId: "target",
			workspaceRoot: workspace,
			threadId: "target",
			key: "input_queue",
			payload: queuedFollowUp("target"),
		});
		seed.saveState({
			sessionId: "target",
			workspaceRoot: workspace,
			threadId: "target",
			key: "compact_checkpoint",
			payload: compactCheckpoint(),
		});
		seed.saveState({
			sessionId: "target",
			workspaceRoot: workspace,
			threadId: "target",
			key: "responses_continuation_state",
			payload: responsesContinuation("target"),
		});
		seed.saveState({
			sessionId: "invalid",
			workspaceRoot: workspace,
			threadId: "invalid",
			key: "responses_continuation_state",
			payload: responsesContinuation("another-session"),
		});
		seed.saveState({
			sessionId: "invalid-suspended",
			workspaceRoot: workspace,
			threadId: "invalid-suspended",
			key: "suspended_turn",
			payload: suspendedApproval("another-session", "call-invalid-suspended"),
		});
	} finally {
		seed.close();
	}
	const legacyDirectory = join(home, ".mycli", "sessions", "legacy");
	await mkdir(legacyDirectory, { recursive: true });
	await writeFile(join(legacyDirectory, "session.json"), JSON.stringify({
		schema_version: 1,
		session_id: "legacy",
		messages: [
			{ role: "user", content: "legacy question" },
			{ role: "assistant", content: "legacy answer" },
		],
	}), "utf8");

	const requests: Record<string, unknown>[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			requests.push(JSON.parse(body) as Record<string, unknown>);
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"target resumed\"}\n\n");
			response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_target\"}}\n\n");
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "source", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));

	writeRequest(backend, "approval-resume", "session.resume", { session_id: "approval" });
	const approvalResume = await waitFor(() => response(messages, "approval-resume"));
	assert.equal(resultValue(approvalResume, "session_id"), "approval");
	const approvalEvent = await waitFor(() => sessionEvent(messages, "approval.request", "approval"));
	assert.equal(paramValue(approvalEvent, "decision_id"), "call-approval");
	writeRequest(backend, "approval-reject", "approval.respond", {
		decision_id: "call-approval",
		choice: "reject",
	});
	const approvalRejected = await waitFor(() => response(messages, "approval-reject"));
	assert.equal(resultValue(approvalRejected, "accepted"), true);
	await waitFor(() => messages.find((message) => {
		if (message.method !== "turn.completed") return false;
		const params = message.params as Record<string, unknown> | undefined;
		return params?.client_turn_id === "approval-client-approval";
	}));

	writeRequest(backend, "invalid-resume", "session.resume", { session_id: "invalid" });
	const invalidResume = await waitFor(() => response(messages, "invalid-resume"));
	assert.equal(errorValue(invalidResume, "code"), "session_state_invalid");
	writeRequest(backend, "status-after-failure", "status.get", {});
	const statusAfterFailure = await waitFor(() => response(messages, "status-after-failure"));
	assert.equal(resultValue(statusAfterFailure, "session_id"), "approval");
	writeRequest(backend, "invalid-suspended-resume", "session.resume", {
		session_id: "invalid-suspended",
	});
	const invalidSuspendedResume = await waitFor(() => response(messages, "invalid-suspended-resume"));
	assert.equal(errorValue(invalidSuspendedResume, "code"), "session_state_invalid");

	writeRequest(backend, "legacy-resume", "session.resume", { session_id: "legacy" });
	const legacyResume = await waitFor(() => response(messages, "legacy-resume"));
	assert.equal(resultValue(legacyResume, "session_id"), "legacy");
	assert.equal(resultValue(legacyResume, "read_only"), false);
	writeRequest(backend, "legacy-transcript", "transcript.load", { session_id: "legacy" });
	const legacyTranscript = await waitFor(() => response(messages, "legacy-transcript"));
	assert.match(JSON.stringify(resultValue(legacyTranscript, "items")), /legacy question/);

	writeRequest(backend, "target-resume", "session.resume", { session_id: "target" });
	const targetResume = await waitFor(() => response(messages, "target-resume"));
	assert.equal(resultValue(targetResume, "session_id"), "target");
	const targetStatus = await waitFor(() => sessionEvent(messages, "status.changed", "target"));
	assert.deepEqual(paramValue(targetStatus, "queued_follow_up"), ["queued target follow-up"]);
	writeRequest(backend, "target-transcript", "transcript.load", { session_id: "target" });
	const transcript = await waitFor(() => response(messages, "target-transcript"));
	assert.match(JSON.stringify(resultValue(transcript, "items")), /target question/);

	writeRequest(backend, "target-turn", "turn.submit", {
		message: "continue target",
		client_turn_id: "target-client-turn",
		client_user_message_id: "target-user-message",
	});
	await waitFor(() => messages.find((message) => {
		if (message.method !== "message.complete") return false;
		const params = message.params as Record<string, unknown> | undefined;
		return params?.final === true
			&& params.text === "target resumed"
			&& params.client_turn_id === "target-client-turn";
	}));
	const resumedRequests = requests.slice(1);
	assert.ok(resumedRequests.some((request) => (
		JSON.stringify(request.input).includes("target question")
	)));
	assert.equal(resumedRequests.some((request) => (
		JSON.stringify(request.input).includes("source question")
	)), false);

	writeRequest(backend, "shutdown", "shutdown", {});
	assert.equal(await backend.completion, 0);
	const reopened = new SQLiteSessionStore({ dbPath });
	try {
		assert.ok(reopened.loadTurn("target", "target-client-turn"));
		assert.equal(reopened.loadTurn("source", "target-client-turn"), undefined);
	} finally {
		reopened.close();
	}
});

test("Node backend interrupts an orphaned claimed approval effect without replay", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-approval-recovery-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(home);
	await mkdir(workspace);
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	const dbPath = join(home, ".mycli", "sessions.db");
	const seed = new SQLiteSessionStore({ dbPath });
	try {
		seed.reserveTurn({
			sessionId: "approval-recovery",
			clientTurnId: "approval-client",
			clientUserMessageId: "approval-client",
			turnId: "approval-turn",
			requestFingerprint: fingerprintSubmission({ message: "write notes", localImages: [] }),
			workspaceRoot: workspace,
			threadId: "approval-recovery",
			userText: "write notes",
			startedAt: "2026-08-04T00:00:00.000Z",
		});
		seed.appendAssistantToolCalls({
			sessionId: "approval-recovery",
			clientTurnId: "approval-client",
			assistantText: "",
			calls: [{
				callId: "call-write",
				name: "Write",
				argumentsJson: JSON.stringify({ file_path: "notes.txt", content: "hello" }),
			}],
			responseId: "resp-tools",
		});
		seed.saveApprovalSuspension({
			sessionId: "approval-recovery",
			workspaceRoot: workspace,
			threadId: "approval-recovery",
			pendingDecision: {
				kind: "pending_decision",
				version: 1,
				payload: pendingDecision("call-write") as Extract<RuntimeStateRecord, {
					kind: "pending_decision";
				}>["payload"],
			},
			suspendedTurn: {
				kind: "suspended_turn",
				version: 1,
				payload: {
					...suspendedApproval("approval-recovery", "call-write"),
					client_turn_id: "approval-client",
					turn_id: "approval-turn",
					conversation: [{ role: "user", content: "write notes" }],
				} as Extract<RuntimeStateRecord, { kind: "suspended_turn" }>["payload"],
			},
			turnRecord: {
				turn_id: "approval-turn",
				client_turn_id: "approval-client",
				user_message: "write notes",
				status: "waiting_approval",
				stop_reason: "approval_required",
				updated_at: "2026-08-04T00:00:00.000Z",
			},
			checkpoint: {
				sessionId: "approval-recovery",
				clientTurnId: "approval-client",
				turnId: "approval-turn",
				decisionId: "call-write",
				callId: "call-write",
				toolName: "Write",
				status: "waiting",
				updatedAt: "2026-08-04T00:00:00.000Z",
			},
		});
		seed.compareAndSetApproval({
			sessionId: "approval-recovery",
			expectedStatus: "waiting",
			transition: { type: "approve_once" },
		});
		seed.compareAndSetApproval({
			sessionId: "approval-recovery",
			expectedStatus: "approved",
			transition: { type: "claim_effect", fingerprint: "sha256:claimed" },
		});
	} finally {
		seed.close();
	}

	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "approval-recovery", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: "http://127.0.0.1:9/v1",
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	writeRequest(backend, "shutdown", "shutdown", {});
	assert.equal(await backend.completion, 0);

	const reopened = new SQLiteSessionStore({ dbPath });
	try {
		const turn = reopened.loadTurn("approval-recovery", "approval-client");
		assert.equal(turn?.status, "interrupted");
		assert.equal((turn?.result as Record<string, unknown> | null)?.error_kind, "effect_outcome_unknown");
		assert.equal(reopened.loadState("approval-recovery", "pending_decision"), undefined);
	} finally {
		reopened.close();
	}
});

test("Node backend restores a durably queued follow-up without provider IO", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-queue-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(home);
	await mkdir(workspace);
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	const options = {
		cwd: workspace,
		args: ["--session", "queue-session", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: "http://127.0.0.1:9/v1",
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	} as const;

	const first = await startNodeBackend(options);
	const firstMessages: Array<Record<string, unknown>> = [];
	createInterface({ input: first.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		firstMessages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(firstMessages, "runtime.ready"));
	writeRequest(first, "queue", "turn.follow_up", {
		message: "persist across restart",
		client_turn_id: "queued-client",
	});
	const queued = await waitFor(() => response(firstMessages, "queue"));
	assert.equal(resultValue(queued, "queue_revision"), 1);
	writeRequest(first, "shutdown-first", "shutdown", {});
	assert.equal(await first.completion, 0);

	const second = await startNodeBackend(options);
	const secondMessages: Array<Record<string, unknown>> = [];
	createInterface({ input: second.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		secondMessages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(secondMessages, "runtime.ready"));
	writeRequest(second, "bootstrap", "session.bootstrap", { protocol_version: 1 });
	const bootstrap = await waitFor(() => response(secondMessages, "bootstrap"));
	const status = resultValue(bootstrap, "status") as Record<string, unknown>;
	assert.equal(status.queue_revision, 1);
	assert.deepEqual(status.queued_follow_up, ["persist across restart"]);
	const migration = resultValue(bootstrap, "legacy_user_queue_migration") as Record<string, unknown>;
	assert.equal((migration.records as Array<Record<string, unknown>>)[0]?.text, "persist across restart");
	writeRequest(second, "shutdown-second", "shutdown", {});
	assert.equal(await second.completion, 0);
});

test("Node backend wires retained provider-free slash commands to durable services", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-command-services-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	const dbPath = join(home, ".mycli", "sessions.db");
	const seed = new SQLiteSessionStore({ dbPath });
	try {
		seedCompletedSession(
			seed,
			workspace,
			"search-source",
			"the retained parity needle",
			"searchable answer",
		);
	} finally {
		seed.close();
	}
	t.after(async () => { await rm(root, { recursive: true, force: true }); });

	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "command-session", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: "http://127.0.0.1:9/v1",
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	let requestNumber = 0;
	const runCommand = async (command: string): Promise<Record<string, unknown>> => {
		requestNumber += 1;
		const id = `command-${requestNumber}`;
		writeRequest(backend, id, "command.run", { command, surface: "tui" });
		return await waitFor(() => response(messages, id));
	};

	const memoryAdded = await runCommand("/memory add project M8 parity :: retained parity memory");
	assert.equal(resultValue(memoryAdded, "execution"), "backend");
	assert.equal(displayValue(memoryAdded, "kind"), "notice");
	const memorySearch = await runCommand("/memory search retained parity");
	assert.equal(displayValue(memorySearch, "kind"), "list");
	assert.match(JSON.stringify(displayValue(memorySearch, "rows")), /M8 parity/u);

	const compact = await runCommand("/compact");
	assert.equal(resultValue(compact, "command_kind"), "compact");
	assert.equal(resultValue(compact, "compaction_status"), "not_needed");
	const tasks = await runCommand("/tasks agents");
	assert.equal(displayValue(tasks, "title"), "Background agents");
	assert.equal(displayValue(tasks, "total_rows"), 0);

	const search = await runCommand("/session search parity needle");
	assert.equal(displayValue(search, "kind"), "list");
	assert.match(JSON.stringify(displayValue(search, "rows")), /search-source/u);
	const maintenance = await runCommand("/session maintenance");
	assert.equal(displayValue(maintenance, "title"), "Session maintenance");
	assert.equal(displayValue(maintenance, "kind"), "list");

	const resume = await runCommand("/resume search-source");
	assert.equal(resultValue(resume, "mutated_session"), true);
	assert.equal(resultValue(resume, "session_id"), "search-source");
	const trace = await runCommand("/trace");
	assert.equal(displayValue(trace, "title"), "Trace");
	assert.match(JSON.stringify(displayValue(trace, "rows")), /seed-turn-search-source/u);
	const fork = await runCommand("/fork search-source forked-session 2");
	assert.equal(resultValue(fork, "mutated_session"), true);
	assert.equal(resultValue(fork, "session_id"), "forked-session");

	writeRequest(backend, "shutdown-command-services", "shutdown", {});
	assert.equal(await backend.completion, 0);
});

test("Node backend undoes a file created by a real provider tool turn", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-command-undo-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	let requests = 0;
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			requests += 1;
			response.writeHead(200, { "content-type": "text/event-stream" });
			if (requests === 1) {
				response.write(`data: ${JSON.stringify({
					type: "response.output_item.done",
					item: {
						type: "function_call",
						call_id: "call-write-undo",
						name: "Write",
						arguments: JSON.stringify({
							file_path: "undo-created.txt",
							content: "created for undo\n",
						}),
					},
				})}\n\n`);
				response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-write-undo\"}}\n\n");
			} else {
				response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Created.\"}\n\n");
				response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-write-final\"}}\n\n");
			}
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "undo-session", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	writeRequest(backend, "write-turn", "turn.submit", {
		message: "Create undo-created.txt.",
		client_turn_id: "undo-client-turn",
		client_user_message_id: "undo-user-message",
	});
	await waitFor(() => messages.find((message) => {
		if (message.method !== "message.complete") return false;
		const params = message.params as Record<string, unknown> | undefined;
		return params?.final === true;
	}));
	assert.equal(await readFile(join(workspace, "undo-created.txt"), "utf8"), "created for undo\n");
	writeRequest(backend, "changes-command", "command.run", { command: "/changes", surface: "tui" });
	const changes = await waitFor(() => response(messages, "changes-command"));
	const changeRows = displayValue(changes, "rows") as Array<Record<string, unknown>>;
	assert.deepEqual(changeRows.map((row) => row.label), ["undo-created.txt"]);

	writeRequest(backend, "undo-command", "command.run", { command: "/undo", surface: "tui" });
	const undo = await waitFor(() => response(messages, "undo-command"));
	assert.equal(displayValue(undo, "kind"), "notice");
	assert.equal(resultValue(undo, "deleted_count"), 1);
	assert.equal(existsSync(join(workspace, "undo-created.txt")), false);

	writeRequest(backend, "shutdown-undo", "shutdown", {});
	assert.equal(await backend.completion, 0);
});

test("Node backend persists canonical TUI control state without exposing credentials", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-controls-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([
		mkdir(home),
		mkdir(join(workspace, "src"), { recursive: true }),
	]);
	await mkdir(join(home, ".mycli"));
	await writeFile(join(home, ".mycli", "auth.json"), `${JSON.stringify({
		"catalog-account": { type: "api_key", key: "catalog-control-secret" },
	}, null, 2)}\n`, "utf8");
	await writeFile(join(home, ".mycli", "models.json"), `${JSON.stringify({
		models: [{
			model: "gpt-selected",
			provider: "openai",
			protocol: "responses",
			base_url: "https://example.invalid/v1",
			auth_ref: "catalog-account",
			description: "Integration catalog model",
			reasoning_efforts: ["low", "high"],
			default_reasoning_effort: "low",
		}],
	}, null, 2)}\n`, "utf8");
	await writeFile(join(workspace, "src", "README.md"), "control fixture\n", "utf8");
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	const options = {
		cwd: workspace,
		args: ["--session", "control-session"],
		env: { HOME: home },
	} as const;

	const first = await startNodeBackend(options);
	const firstMessages: Array<Record<string, unknown>> = [];
	createInterface({ input: first.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		firstMessages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(firstMessages, "runtime.ready"));

	writeRequest(first, "bootstrap", "session.bootstrap", { protocol_version: 1 });
	const bootstrap = await waitFor(() => response(firstMessages, "bootstrap"));
	assert.equal((resultValue(bootstrap, "auth_providers") as unknown[]).length > 0, true);
	const bootstrapModels = resultValue(bootstrap, "models") as Array<Record<string, unknown>>;
	assert.deepEqual(bootstrapModels.map((entry) => entry.model), ["gpt-selected"]);

	writeRequest(first, "auth", "auth.api_key.save", {
		provider_id: "openai",
		api_key: "integration-control-secret",
	});
	const auth = await waitFor(() => response(firstMessages, "auth"));
	assert.equal(resultValue(auth, "ok"), true);
	assert.equal(JSON.stringify(auth).includes("integration-control-secret"), false);

	writeRequest(first, "model", "model.select", {
		provider: "openai",
		protocol: "responses",
		model: "gpt-selected",
		base_url: "https://example.invalid/v1",
		reasoning_effort: "high",
	});
	const model = await waitFor(() => response(firstMessages, "model"));
	assert.equal((resultValue(model, "selected") as Record<string, unknown>).model, "gpt-selected");

	writeRequest(first, "settings", "settings.save", {
		settings: { viewMode: "verbose", statusbarMode: "compact", hideThinking: false },
	});
	const settings = await waitFor(() => response(firstMessages, "settings"));
	assert.equal((resultValue(settings, "settings") as Record<string, unknown>).view_mode, "verbose");

	writeRequest(first, "path", "completion.path", { prefix: "@src/" });
	const completion = await waitFor(() => response(firstMessages, "path"));
	assert.deepEqual(resultValue(completion, "items"), [{ value: "@src/README.md", kind: "file" }]);
	writeRequest(first, "shutdown-controls", "shutdown", {});
	assert.equal(await first.completion, 0);

	const configRaw = await readFile(join(home, ".mycli", "config.toml"), "utf8");
	assert.equal(configRaw.includes("integration-control-secret"), false);
	assert.equal(configRaw.includes("catalog-control-secret"), false);
	assert.equal(configRaw.includes('auth_ref = "catalog-account"'), true);
	const second = await startNodeBackend(options);
	const secondMessages: Array<Record<string, unknown>> = [];
	createInterface({ input: second.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		secondMessages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(secondMessages, "runtime.ready"));
	writeRequest(second, "bootstrap-restarted", "session.bootstrap", { protocol_version: 1 });
	const restarted = await waitFor(() => response(secondMessages, "bootstrap-restarted"));
	assert.equal(resultValue(restarted, "model"), "gpt-selected");
	const providers = resultValue(restarted, "auth_providers") as Array<Record<string, unknown>>;
	assert.equal(providers.find((provider) => provider.id === "openai")?.configured, true);
	writeRequest(second, "settings-restarted", "settings.load", {});
	const restartedSettings = await waitFor(() => response(secondMessages, "settings-restarted"));
	assert.equal(
		(resultValue(restartedSettings, "settings") as Record<string, unknown>).statusbar_mode,
		"compact",
	);
	writeRequest(second, "shutdown-controls-restarted", "shutdown", {});
	assert.equal(await second.completion, 0);
});

function writeRequest(
	backend: Awaited<ReturnType<typeof startNodeBackend>>,
	id: string,
	method: string,
	params: Record<string, unknown>,
): void {
	backend.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function event(messages: Array<Record<string, unknown>>, method: string): Record<string, unknown> | undefined {
	return messages.find((message) => message.method === method && !("id" in message));
}

function sessionEvent(
	messages: Array<Record<string, unknown>>,
	method: string,
	sessionId: string,
): Record<string, unknown> | undefined {
	return messages.find((message) => message.method === method
		&& !("id" in message)
		&& paramValue(message, "session_id") === sessionId);
}

function response(
	messages: Array<Record<string, unknown>>,
	id: string,
): Record<string, unknown> | undefined {
	return messages.find((message) => String(message.id) === id);
}

function resultValue(message: Record<string, unknown>, key: string): unknown {
	const result = message.result;
	return typeof result === "object" && result !== null && !Array.isArray(result)
		? (result as Record<string, unknown>)[key]
		: undefined;
}

function displayValue(message: Record<string, unknown>, key: string): unknown {
	const display = resultValue(message, "display");
	return typeof display === "object" && display !== null && !Array.isArray(display)
		? (display as Record<string, unknown>)[key]
		: undefined;
}

function toolNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((tool) => {
		if (typeof tool !== "object" || tool === null || !("name" in tool)) return [];
		return typeof tool.name === "string" ? [tool.name] : [];
	});
}

function isSubagentRequest(payload: Readonly<Record<string, unknown>>): boolean {
	if (!Array.isArray(payload.input)) return false;
	return payload.input.some((item) => (
		typeof item === "object"
		&& item !== null
		&& "role" in item
		&& item.role === "developer"
		&& "content" in item
		&& typeof item.content === "string"
		&& item.content.includes("You are a subagent operating under the parent agent's delegated authority.")
	));
}

function errorValue(message: Record<string, unknown>, key: string): unknown {
	const error = message.error;
	return typeof error === "object" && error !== null && !Array.isArray(error)
		? (error as Record<string, unknown>)[key]
		: undefined;
}

function paramValue(message: Record<string, unknown>, key: string): unknown {
	const params = message.params;
	return typeof params === "object" && params !== null && !Array.isArray(params)
		? (params as Record<string, unknown>)[key]
		: undefined;
}

function seedCompletedSession(
	store: SQLiteSessionStore,
	workspaceRoot: string,
	sessionId: string,
	userText: string,
	assistantText: string,
): void {
	store.reserveTurn({
		sessionId,
		clientTurnId: `seed-client-${sessionId}`,
		clientUserMessageId: `seed-client-${sessionId}`,
		turnId: `seed-turn-${sessionId}`,
		requestFingerprint: fingerprintSubmission({ message: userText, localImages: [] }),
		workspaceRoot,
		threadId: sessionId,
		userText,
		startedAt: "2026-08-04T00:00:00.000Z",
	});
	store.completeTurn({
		sessionId,
		clientTurnId: `seed-client-${sessionId}`,
		assistantText,
		usage: {},
		completedAt: "2026-08-04T00:00:01.000Z",
	});
}

function seedWaitingApproval(
	store: SQLiteSessionStore,
	workspaceRoot: string,
	sessionId: string,
	callId: string,
): void {
	const clientTurnId = `approval-client-${sessionId}`;
	const turnId = `approval-turn-${sessionId}`;
	const userText = "update the notes";
	store.reserveTurn({
		sessionId,
		clientTurnId,
		clientUserMessageId: clientTurnId,
		turnId,
		requestFingerprint: fingerprintSubmission({ message: userText, localImages: [] }),
		workspaceRoot,
		threadId: sessionId,
		userText,
		startedAt: "2026-08-04T00:00:02.000Z",
	});
	store.appendAssistantToolCalls({
		sessionId,
		clientTurnId,
		assistantText: "",
		calls: [{
			callId,
			name: "Write",
			argumentsJson: JSON.stringify({ file_path: "notes.txt", content: "hello" }),
		}],
		responseId: "resp-tools",
	});
	store.saveApprovalSuspension({
		sessionId,
		workspaceRoot,
		threadId: sessionId,
		pendingDecision: {
			kind: "pending_decision",
			version: 1,
			payload: pendingDecision(callId) as Extract<RuntimeStateRecord, {
				kind: "pending_decision";
			}>["payload"],
		},
		suspendedTurn: {
			kind: "suspended_turn",
			version: 1,
			payload: {
				...suspendedApproval(sessionId, callId),
				user_message: userText,
				client_turn_id: clientTurnId,
				turn_id: turnId,
				conversation: [{ role: "user", content: userText }],
				continuation: {
					assistant_text: "",
					response_id: "resp-tools",
					usage: {},
				},
			} as Extract<RuntimeStateRecord, { kind: "suspended_turn" }>["payload"],
		},
		turnRecord: {
			turn_id: turnId,
			client_turn_id: clientTurnId,
			user_message: userText,
			status: "waiting_approval",
			stop_reason: "approval_required",
			updated_at: "2026-08-04T00:00:02.000Z",
		},
		checkpoint: {
			sessionId,
			clientTurnId,
			turnId,
			decisionId: callId,
			callId,
			toolName: "Write",
			status: "waiting",
			updatedAt: "2026-08-04T00:00:02.000Z",
		},
	});
}

function pendingDecision(callId: string): Record<string, unknown> {
	return {
		tool_call: {
			name: "Write",
			arguments: { file_path: "notes.txt", content: "hello" },
			reason: "Update notes",
			call_id: callId,
		},
		kind: "needs_choice",
		reason: "A workspace file will change.",
		preview: "Write notes.txt",
		options: ["approve_once", "reject"],
		command_pattern: null,
		proposed_execpolicy_pattern: null,
		metadata: {},
	};
}

function suspendedApproval(sessionId: string, callId: string): Record<string, unknown> {
	return {
		user_message: "update the notes",
		conversation: [],
		suspend_reason: "approval_required",
		plan_items: [],
		pending_approval: {
			tool_call: pendingDecision(callId).tool_call,
			reason: "A workspace file will change.",
			preview: "Write notes.txt",
			command_pattern: null,
			proposed_execpolicy_pattern: null,
			metadata: {},
		},
		pending_clarification: null,
		session_id: sessionId,
		client_turn_id: `approval-client-${sessionId}`,
		turn_id: `approval-turn-${sessionId}`,
		provider_protocol: "responses",
		remaining_tool_calls: [],
		continuation: {},
	};
}

function queuedFollowUp(sessionId: string): Record<string, unknown> {
	return {
		session_id: sessionId,
		revision: 1,
		pending_steers: [],
		rejected_steers: [],
		follow_ups: [{
			queue_id: "queue-target",
			session_id: sessionId,
			client_turn_id: "queue-client-target",
			target_turn_id: null,
			kind: "follow_up",
			state: "queued",
			text: "queued target follow-up",
			image_paths: [],
			source: "user",
			created_at: "2026-08-04T00:00:02.000Z",
			updated_at: "2026-08-04T00:00:02.000Z",
		}],
	};
}

function compactCheckpoint(): Record<string, unknown> {
	return {
		version: 1,
		turn_id: "seed-turn-target",
		reason: "context_limit",
		phase: "before_provider",
		window_number: 1,
		window_id: "window-target",
		history_item_count: 2,
		input_history_hash: "sha256:input",
		replacement_history_hash: "sha256:replacement",
		replacement_messages: [],
	};
}

function responsesContinuation(sessionId: string): Record<string, unknown> {
	return {
		response_id: "resp-seed",
		request_signature: "sha256:request",
		request_input: [],
		response_output: [],
		eligible: true,
		failure_reason: null,
		session_id: sessionId,
		protocol: "responses",
		model: "gpt-test",
		history_boundary: "history-2",
	};
}

async function jsonLines(path: string): Promise<readonly Record<string, unknown>[]> {
	return (await readFile(path, "utf8"))
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitFor<T>(read: () => T | undefined | false, timeoutMs = 3_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("timed out waiting for Node backend");
}
