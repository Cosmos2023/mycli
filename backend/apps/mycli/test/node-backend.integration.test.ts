import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseJsonRpcMessage, type RuntimeStateRecord } from "@mycli/contracts";
import { fingerprintSubmission, rootAgentPath } from "@mycli/core";
import {
	encodeSessionContentBlob,
	MODEL_INPUT_CONTENT_BLOB_MARKER_JSON,
	openRuntimeSessionStore,
	SCHEMA_V12_VERSION,
	subagentRunId,
	type RuntimeSessionStore,
} from "@mycli/storage";
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

test("Node backend rejects invalid lane-specific agent execution adapters before startup", async () => {
	for (const environmentKey of [
		"MYCLI_ROOT_AGENT_EXECUTION_ADAPTER",
		"MYCLI_SUBAGENT_EXECUTION_ADAPTER",
	] as const) {
		await assert.rejects(startNodeBackend({
			cwd: process.cwd(),
			args: [],
			env: { [environmentKey]: "automatic" },
		}), new RegExp(environmentKey, "u"));
	}
});

test("Node backend rejects invalid managed execution policy before runtime startup", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-managed-policy-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([
		mkdir(join(home, ".mycli"), { recursive: true }),
		mkdir(workspace),
	]);
	await writeFile(join(home, ".mycli", "managed_config.toml"), [
		"[execution_policy]",
		'network = "unrestricted"',
	].join("\n"), "utf8");
	t.after(() => rm(root, { recursive: true, force: true }));

	await assert.rejects(startNodeBackend({
		cwd: workspace,
		args: ["--session", "invalid-managed-policy"],
		env: { HOME: home },
	}), /config_error: invalid managed execution policy/u);
});

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

test("fresh schema-v12 bootstrap loads the virtual session transcript without persisting it", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-virtual-session-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "virtual-initial", "--model", "gpt-test"],
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
	t.after(async () => {
		await backend.close();
		await rm(root, { recursive: true, force: true });
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));

	writeRequest(backend, "bootstrap-virtual", "session.bootstrap", { protocol_version: 1 });
	const bootstrap = await waitFor(() => response(messages, "bootstrap-virtual"));
	assert.equal(resultValue(bootstrap, "session_id"), "virtual-initial");
	writeRequest(backend, "transcript-virtual", "transcript.load", {
		session_id: "virtual-initial",
		before: null,
		limit: 500,
	});
	const transcript = await waitFor(() => response(messages, "transcript-virtual"));
	assert.deepEqual(transcript.result, {
		session_id: "virtual-initial",
		items: [],
		next_before: null,
		read_only: false,
	});
	writeRequest(backend, "resume-missing", "session.resume", { session_id: "missing-session" });
	const missingResume = await waitFor(() => response(messages, "resume-missing"));
	assert.equal(
		(missingResume.error as Readonly<Record<string, unknown>> | undefined)?.code,
		"session_not_found",
	);

	const database = new DatabaseSync(join(home, ".mycli", "sessions.db"), { readOnly: true });
	try {
		assert.equal(database.prepare("SELECT version FROM schema_version").get()?.version, SCHEMA_V12_VERSION);
		assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count, 0);
	} finally {
		database.close();
	}

	writeRequest(backend, "shutdown-virtual", "shutdown", {});
	assert.equal(await backend.completion, 0);
});

test("Node backend gives one live window exclusive ownership of a session", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-session-owner-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	const seed = openRuntimeSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		seedCompletedSession(
			seed,
			workspace,
			"exclusive-session",
			"exclusive question",
			"exclusive answer",
		);
	} finally {
		seed.close();
	}
	const options = {
		cwd: workspace,
		args: ["--session", "exclusive-session", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: "http://127.0.0.1:1/v1",
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_MEMORY_ENABLED: "false",
		},
	} as const;
	const first = await startNodeBackend(options);
	let unexpectedSecond: Awaited<ReturnType<typeof startNodeBackend>> | undefined;
	let unexpectedReleasedSource: Awaited<ReturnType<typeof startNodeBackend>> | undefined;
	const additionalBackends: Array<Awaited<ReturnType<typeof startNodeBackend>>> = [];
	t.after(async () => {
		await unexpectedSecond?.close();
		await unexpectedReleasedSource?.close();
		for (const backend of additionalBackends) await backend.close();
		await first.close();
		await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
	});

	try {
		unexpectedSecond = await startNodeBackend(options);
		assert.fail("second backend unexpectedly acquired the live session");
	} catch (error) {
		assert.equal(
			typeof error === "object" && error !== null && "code" in error
				? error.code
				: undefined,
			"session_in_use",
		);
	}

	const other = await startNodeBackend({
		...options,
		args: ["--session", "other-session", "--model", "gpt-test"],
	});
	additionalBackends.push(other);
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: other.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	writeRequest(other, "resume-owned", "session.resume", { session_id: "exclusive-session" });
	const blocked = await waitFor(() => response(messages, "resume-owned"));
	assert.equal(errorValue(blocked, "code"), "session_in_use");
	assert.equal(
		errorValue(blocked, "message"),
		"Session is already open in another mycli window.",
	);

	await first.close();
	writeRequest(other, "resume-released", "session.resume", { session_id: "exclusive-session" });
	const resumed = await waitFor(() => response(messages, "resume-released"));
	assert.equal(resultValue(resumed, "session_id"), "exclusive-session");
	try {
		unexpectedReleasedSource = await startNodeBackend({
			...options,
			args: ["--session", "other-session", "--model", "gpt-test"],
		});
		assert.fail("session switch unexpectedly released the source ownership");
	} catch (error) {
		assert.equal(
			typeof error === "object" && error !== null && "code" in error
				? error.code
				: undefined,
			"session_in_use",
		);
	}
	await other.close();
	const restarted = await startNodeBackend(options);
	additionalBackends.push(restarted);
	await restarted.close();
	const releasedSource = await startNodeBackend({
		...options,
		args: ["--session", "other-session", "--model", "gpt-test"],
	});
	additionalBackends.push(releasedSource);
	await releasedSource.close();
});

test("Worker-backed root composes sessions, provider streaming, transcripts, and SQLite", async (t) => {
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
			MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
			MYCLI_REQUEST_PERMISSIONS_TOOL: "true",
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
		providerToolNames(capture.requestBody?.tools),
			[
				"Read", "Edit", "Patch", "Write", "request_permissions", "update_plan", "web_fetch",
				"tool_search", "Skill",
				"spawn_agent", "send_message", "followup_task", "interrupt_agent", "list_agents",
				"wait_agent", "web_search",
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
	const reopened = openRuntimeSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
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
	writeRequest(backend, "plan-trace", "trace.export", { tail: 20 });
	const trace = await waitFor(() => response(messages, "plan-trace"));
	const traceRows = resultValue(trace, "rows") as readonly string[];
	const streamDiagnostics = traceRows
		.map((row) => JSON.parse(row) as Record<string, unknown>)
		.filter((row) => row.kind === "model_stream_diagnostics");
	assert.equal(streamDiagnostics.length, 2);
	assert.equal(
		(streamDiagnostics[0]?.payload as Record<string, unknown> | undefined)?.provider,
		"openai",
	);
	assert.equal(
		typeof (streamDiagnostics[0]?.payload as Record<string, unknown> | undefined)?.ttfb_ms,
		"number",
	);
	assert.equal(JSON.stringify(streamDiagnostics).includes("Plan the implementation."), false);
	assert.equal(JSON.stringify(streamDiagnostics).includes("Plan recorded."), false);

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
	const store = openRuntimeSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		assert.deepEqual(store.loadConversationItems("plan-session").map((item) => item.type), [
			"user", "assistant_tool_calls", "tool_result", "assistant",
		]);
	} finally {
		store.close();
	}
});

test("Node backend Plan mode adds structured clarification after /plan", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-plan-exposure-"));
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
			response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Plan inspected.\"}\n\n");
			response.write(`data: {"type":"response.completed","response":{"id":"resp_plan_exposure_${requestBodies.length}"}}\n\n`);
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
		args: ["--session", "plan-exposure-session", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
			MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
		},
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));

	writeRequest(backend, "trust-plan-exposure", "workspace.trust.set", { state: "trusted" });
	await waitFor(() => response(messages, "trust-plan-exposure"));
	writeRequest(backend, "permission-plan-exposure", "permissions.update", { profile: "workspace" });
	await waitFor(() => response(messages, "permission-plan-exposure"));
	writeRequest(backend, "submit-default-exposure", "turn.submit", {
		message: "Inspect the repository.",
		client_turn_id: "default-exposure-turn",
		client_user_message_id: "default-exposure-message",
	});
	await waitFor(() => finalMessageCount(messages) === 1);
	const defaultCompleted = await waitFor(() => messages.find((message) => (
		message.method === "turn.completed"
		&& paramValue(message, "client_turn_id") === "default-exposure-turn"
	)));
	await waitFor(() => messages.find((message, index) => (
		index > messages.indexOf(defaultCompleted)
		&& message.method === "status.changed"
		&& paramValue(message, "turn_running") === false
	)));
	const defaultNames = toolNames(requestBodies[0]?.tools);
	writeRequest(backend, "enter-plan", "command.run", { command: "/plan", surface: "tui" });
	const enterPlan = await waitFor(() => response(messages, "enter-plan"));
	assert.equal(resultValue(enterPlan, "collaboration_mode"), "plan");
	writeRequest(backend, "submit-plan-exposure", "turn.submit", {
		message: "Inspect the repository and propose a plan.",
		client_turn_id: "plan-exposure-turn",
		client_user_message_id: "plan-exposure-message",
	});
	await waitFor(() => finalMessageCount(messages) === 2);

	const names = toolNames(requestBodies[1]?.tools);
	assert.equal(defaultNames.includes("AskUserQuestion"), false);
	assert.equal(names.includes("AskUserQuestion"), true);
	assert.deepEqual(names.filter((name) => name !== "AskUserQuestion"), defaultNames);
	for (const name of ["Read", "Edit", "Patch", "Write", "update_plan", "Shell", "WriteStdin"]) {
		assert.ok(names.includes(name), `Plan request omitted ${name}: ${names.join(", ")}`);
	}
	assert.match(JSON.stringify(requestBodies[1]?.input), /# Plan Mode/u);

	writeRequest(backend, "shutdown-plan-exposure", "shutdown", {});
	assert.equal(await backend.completion, 0);
});

test("Root adapters preserve canonical persistence, provider, usage, and gateway ordering", {
	timeout: 20_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-root-adapter-parity-"));
	const workspace = join(root, "workspace");
	await mkdir(workspace);
	const requestBodies: Record<string, unknown>[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			const providerStep = requestBodies.length % 2;
			requestBodies.push(JSON.parse(body) as Record<string, unknown>);
			response.writeHead(200, { "content-type": "text/event-stream" });
			if (providerStep === 0) {
				response.write(`data: ${JSON.stringify({
					type: "response.output_item.done",
					item: {
						type: "function_call",
						call_id: "call-root-parity-plan",
						name: "update_plan",
						arguments: JSON.stringify({
							explanation: "Record adapter parity",
							plan: [
								{ step: "Commit canonical input", status: "completed" },
								{ step: "Compare adapters", status: "in_progress" },
							],
						}),
					},
				})}\n\n`);
				response.write('data: {"type":"response.completed","response":{"id":"resp-root-parity-tools","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n');
			} else {
				response.write('data: {"type":"response.output_text.delta","delta":"Root parity complete."}\n\n');
				response.write('data: {"type":"response.completed","response":{"id":"resp-root-parity-final","usage":{"input_tokens":7,"output_tokens":11,"total_tokens":18}}}\n\n');
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
	const snapshots: RootAdapterParitySnapshot[] = [];

	for (const adapter of ["in_process", "worker"] as const) {
		const home = join(root, `home-${adapter}`);
		await mkdir(home);
		const requestStart = requestBodies.length;
		const backend = await startNodeBackend({
			cwd: workspace,
			args: ["--session", "root-adapter-parity", "--model", "gpt-test"],
			env: {
				HOME: home,
				MYCLI_API_KEY: "test-key",
				MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
				MYCLI_PROVIDER: "openai",
				MYCLI_PROTOCOL: "responses",
				MYCLI_THINKING_ENABLED: "false",
				MYCLI_MEMORY_ENABLED: "false",
				MYCLI_STREAM_MAX_RETRIES: "0",
				MYCLI_AGENT_EXECUTION_ADAPTER: adapter,
			},
		});
		const messages: Array<Record<string, unknown>> = [];
		createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
			messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
		});
		await waitFor(() => event(messages, "runtime.ready"));
		writeRequest(backend, `submit-${adapter}`, "turn.submit", {
			message: "Exercise canonical root adapter parity.",
			client_turn_id: "root-adapter-parity-turn",
			client_user_message_id: "root-adapter-parity-message",
		});
		const final = await waitFor(() => messages.find((message) => (
			message.method === "message.complete"
			&& paramValue(message, "final") === true
			&& paramValue(message, "client_turn_id") === "root-adapter-parity-turn"
		)), 8_000);
		const finalIndex = messages.indexOf(final);
		const idle = await waitFor(() => messages.find((message, index) => (
			index > finalIndex
			&& message.method === "status.changed"
			&& paramValue(message, "turn_running") === false
		)), 8_000);
		writeRequest(backend, `transcript-${adapter}`, "transcript.load", {
			session_id: "root-adapter-parity",
		});
		const transcript = await waitFor(() => response(messages, `transcript-${adapter}`));
		writeRequest(backend, `shutdown-${adapter}`, "shutdown", {});
		assert.equal(await backend.completion, 0);

		const store = openRuntimeSessionStore({
			dbPath: join(home, ".mycli", "sessions.db"),
		});
		try {
			const turn = store.loadTurn("root-adapter-parity", "root-adapter-parity-turn");
			assert.ok(turn);
			const terminalReport = messages.find((message) => (
				message.method === "turn.completed"
				&& paramValue(message, "client_turn_id") === "root-adapter-parity-turn"
			))?.params;
			assert.ok(terminalReport && typeof terminalReport === "object" && !Array.isArray(terminalReport));
			assert.equal(typeof (terminalReport as Record<string, unknown>).duration_ms, "number");
			const startIndex = messages.findIndex((message) => (
				message.method === "item.started"
				&& paramValue(message, "client_turn_id") === "root-adapter-parity-turn"
			));
			assert.notEqual(startIndex, -1);
			snapshots.push({
				conversation: store.loadConversationItems("root-adapter-parity")
					.map(normalizeCanonicalItem),
				providerBodies: requestBodies.slice(requestStart),
				providerSteps: providerStepSnapshots(store, "root-adapter-parity"),
				turn: {
					status: turn.status,
					errorCode: turn.error_code,
					result: turn.result,
				},
				terminalReport: normalizeGatewayParams(terminalReport),
				transcript: normalizeTranscriptItems(resultValue(transcript, "items")),
				gatewayOrder: messages.slice(startIndex, messages.indexOf(idle) + 1)
					.flatMap((message) => typeof message.method === "string"
						&& message.method !== "runtime.event"
						&& message.method !== "extension.updated" ? [message.method] : []),
			});
		} finally {
			store.close();
		}
	}

	assert.equal(requestBodies.length, 4);
	assert.deepEqual(snapshots[1], snapshots[0]);
	const snapshot = snapshots[0] as RootAdapterParitySnapshot;
	assert.deepEqual(snapshot.conversation.map((item) => (
		typeof item === "object" && item !== null && "type" in item ? item.type : undefined
	)), ["user", "assistant_tool_calls", "tool_result", "assistant"]);
	assert.deepEqual(snapshot.providerSteps.map((step) => step.lifecycle), [
		["prepared", "dispatch_started", "acknowledged"],
		["prepared", "dispatch_started", "acknowledged"],
	]);
	assert.deepEqual(
		(snapshot.turn.result as Record<string, unknown>).usage,
		{ input_tokens: 9, output_tokens: 14, total_tokens: 23 },
	);
	assert.deepEqual(snapshot.gatewayOrder.slice(-5), [
		"turn.completed",
		"turn.status",
		"message.complete",
		"status.update",
		"status.changed",
	]);
});

test("Explicit in-process rollback resumes default Worker state without duplicate effects", {
	timeout: 20_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-root-adapter-rollback-"));
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
						call_id: "call-worker-rollback-plan",
						name: "update_plan",
						arguments: JSON.stringify({
							explanation: "Persist before rollback",
							plan: [{ step: "Persist Worker state", status: "completed" }],
						}),
					},
				})}\n\n`);
				response.write('data: {"type":"response.completed","response":{"id":"resp-worker-rollback-tools","usage":{"total_tokens":4}}}\n\n');
			} else if (requestBodies.length === 2) {
				response.write('data: {"type":"response.output_text.delta","delta":"Worker state persisted."}\n\n');
				response.write('data: {"type":"response.completed","response":{"id":"resp-worker-rollback-final","usage":{"total_tokens":6}}}\n\n');
			} else {
				response.write('data: {"type":"response.output_text.delta","delta":"In-process rollback resumed."}\n\n');
				response.write('data: {"type":"response.completed","response":{"id":"resp-in-process-rollback","usage":{"total_tokens":8}}}\n\n');
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
	const baseEnv: NodeJS.ProcessEnv = {
		HOME: home,
		MYCLI_API_KEY: "test-key",
		MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
		MYCLI_PROVIDER: "openai",
		MYCLI_PROTOCOL: "responses",
		MYCLI_THINKING_ENABLED: "false",
		MYCLI_MEMORY_ENABLED: "false",
		MYCLI_STREAM_MAX_RETRIES: "0",
	};
	const first = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "root-adapter-rollback", "--model", "gpt-test"],
		env: baseEnv,
	});
	const firstMessages: Array<Record<string, unknown>> = [];
	createInterface({ input: first.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		firstMessages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(firstMessages, "runtime.ready"));
	writeRequest(first, "worker-turn", "turn.submit", {
		message: "Persist this turn before adapter rollback.",
		client_turn_id: "worker-rollback-turn",
		client_user_message_id: "worker-rollback-message",
	});
	const workerFinal = await waitFor(() => firstMessages.find((message) => (
		message.method === "message.complete"
		&& paramValue(message, "final") === true
		&& paramValue(message, "client_turn_id") === "worker-rollback-turn"
	)), 8_000);
	await waitFor(() => firstMessages.find((message, index) => (
		index > firstMessages.indexOf(workerFinal)
		&& message.method === "status.changed"
		&& paramValue(message, "turn_running") === false
	)), 8_000);
	writeRequest(first, "shutdown-worker", "shutdown", {});
	assert.equal(await first.completion, 0);

	const dbPath = join(home, ".mycli", "sessions.db");
	const workerStore = openRuntimeSessionStore({ dbPath });
	let workerSteps: readonly ProviderStepSnapshot[];
	try {
		workerSteps = providerStepSnapshots(workerStore, "root-adapter-rollback");
		assert.equal(workerSteps.length, 2);
	} finally {
		workerStore.close();
	}

	const second = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "root-adapter-rollback", "--model", "gpt-test"],
		env: { ...baseEnv, MYCLI_AGENT_EXECUTION_ADAPTER: "in_process" },
	});
	const secondMessages: Array<Record<string, unknown>> = [];
	createInterface({ input: second.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		secondMessages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(secondMessages, "runtime.ready"));
	writeRequest(second, "in-process-turn", "turn.submit", {
		message: "Continue after adapter rollback.",
		client_turn_id: "in-process-rollback-turn",
		client_user_message_id: "in-process-rollback-message",
	});
	const rollbackFinal = await waitFor(() => secondMessages.find((message) => (
		message.method === "message.complete"
		&& paramValue(message, "final") === true
		&& paramValue(message, "client_turn_id") === "in-process-rollback-turn"
	)), 8_000);
	await waitFor(() => secondMessages.find((message, index) => (
		index > secondMessages.indexOf(rollbackFinal)
		&& message.method === "status.changed"
		&& paramValue(message, "turn_running") === false
	)), 8_000);
	writeRequest(second, "shutdown-in-process", "shutdown", {});
	assert.equal(await second.completion, 0);

	assert.equal(requestBodies.length, 3);
	assert.match(JSON.stringify(requestBodies[2]?.input), /Worker state persisted\./u);
	assert.match(JSON.stringify(requestBodies[2]?.input), /call-worker-rollback-plan/u);
	const reopened = openRuntimeSessionStore({ dbPath });
	try {
		assert.deepEqual(reopened.loadConversationItems("root-adapter-rollback")
			.map((item) => item.type), [
			"user", "assistant_tool_calls", "tool_result", "assistant", "user", "assistant",
		]);
		const history = reopened.loadHistoryItems("root-adapter-rollback");
		assert.equal(history.filter((item) => item.type === "plan_update").length, 1);
		assert.equal(reopened.loadTurn("root-adapter-rollback", "worker-rollback-turn")?.status, "completed");
		assert.equal(reopened.loadTurn("root-adapter-rollback", "in-process-rollback-turn")?.status, "completed");
		const allSteps = providerStepSnapshots(reopened, "root-adapter-rollback");
		assert.equal(allSteps.length, 3);
		assert.deepEqual(allSteps.slice(0, 2), workerSteps);
		assert.equal(allSteps[2]?.hasPrevious, true);
		assert.deepEqual(allSteps[2]?.lifecycle, ["prepared", "dispatch_started", "acknowledged"]);
	} finally {
		reopened.close();
	}
	const database = new DatabaseSync(dbPath, { readOnly: true });
	assert.equal(database.prepare("SELECT version FROM schema_version").get()?.version, SCHEMA_V12_VERSION);
	const ownerCount = Number(database.prepare("SELECT COUNT(*) AS count FROM model_input_blobs").get()?.count);
	const referenceCount = Number(database.prepare("SELECT COUNT(*) AS count FROM model_input_blob_refs").get()?.count);
	assert.ok(ownerCount > 0);
	assert.equal(referenceCount, ownerCount);
	assert.equal(Number(database.prepare(`
		SELECT COUNT(*) AS count FROM pragma_table_info('provider_request_manifests')
		WHERE name = 'logical_request_blob_id'
	`).get()?.count), 0);
	assert.equal(Number(database.prepare(`
		SELECT COUNT(*) AS count
		FROM provider_request_manifests AS manifest
		JOIN model_input_blobs AS blob ON blob.blob_id = manifest.logical_request_sha256
	`).get()?.count), 0);
	assert.equal(Number(database.prepare(`
		SELECT COUNT(*) AS count FROM model_input_blobs WHERE payload_json != ?
	`).get(MODEL_INPUT_CONTENT_BLOB_MARKER_JSON)?.count), 0);
	assert.ok(Number(database.prepare(`
		SELECT COUNT(*) AS count
		FROM model_input_blob_refs AS reference
		JOIN session_content_blobs AS content ON content.blob_id = reference.content_blob_id
		WHERE content.codec = 'deflate-raw-v1'
	`).get()?.count) > 0);
	database.close();
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
	const reopened = openRuntimeSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
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

test("Worker-backed root projects steering and follow-up input into TUI transcripts", async (t) => {
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
			MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
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
	const firstFinalIndex = messages.indexOf(final);
	await waitFor(() => messages.slice(firstFinalIndex + 1).find((message) => (
		message.method === "status.changed"
		&& paramValue(message, "turn_running") === false
		&& paramValue(message, "session_id") === "steering-transcript-session"
	)), 5_000);

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
	writeRequest(backend, "deferred-follow-up", "turn.follow_up", {
		message: "Run this as the next turn",
		client_turn_id: "deferred-follow-up-message",
	});
	const deferredAccepted = await waitFor(() => response(messages, "deferred-follow-up"));
	assert.equal(resultValue(deferredAccepted, "disposition"), "queued_follow_up");
	releaseDeferredParentResponse();
	const deferredCommitted = await waitFor(() => messages.find((message) =>
		message.method === "item.completed"
		&& paramValue(message, "client_turn_id") === "deferred-follow-up-message"
		&& (paramValue(message, "item") as Record<string, unknown> | undefined)
			?.client_user_message_id === "deferred-follow-up-message"), 5_000);
	assert.equal(
		(paramValue(deferredCommitted, "item") as Record<string, unknown>).content,
		"Run this as the next turn",
	);
	await waitFor(() => messages.find((message) =>
		message.method === "message.complete"
		&& paramValue(message, "client_turn_id") === "deferred-follow-up-message"
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
		collaboration_mode: "plan",
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
	let final: Record<string, unknown>;
	try {
		final = await waitFor(() => secondMessages.find((message) =>
			message.method === "message.complete"
			&& paramValue(message, "final") === true), 5_000);
	} catch {
		assert.fail(JSON.stringify(secondMessages.map((message) => ({
			method: message.method,
			code: paramValue(message, "code") ?? errorValue(message, "code"),
			state: paramValue(message, "state"),
		}))));
	}
	assert.equal(paramValue(final, "text"), "Node selected.");
	assert.equal(requestBodies.length, 2);
	assert.equal(JSON.stringify(requestBodies[1]?.input).includes("User response: Node"), true);

	writeRequest(second, "shutdown-second", "shutdown", {});
	assert.equal(await second.completion, 0);
	const reopened = openRuntimeSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
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

const AGENT_EXECUTION_TOPOLOGIES = Object.freeze([
	{
		name: "default Worker",
		environment: {},
	},
	{
		name: "legacy in-process",
		environment: { MYCLI_AGENT_EXECUTION_ADAPTER: "in_process" },
	},
	{
		name: "legacy Worker",
		environment: { MYCLI_AGENT_EXECUTION_ADAPTER: "worker" },
	},
	{
		name: "in-process root and Worker subagent",
		environment: {
			MYCLI_ROOT_AGENT_EXECUTION_ADAPTER: "in_process",
			MYCLI_SUBAGENT_EXECUTION_ADAPTER: "worker",
		},
	},
	{
		name: "Worker root and in-process subagent",
		environment: {
			MYCLI_ROOT_AGENT_EXECUTION_ADAPTER: "worker",
			MYCLI_SUBAGENT_EXECUTION_ADAPTER: "in_process",
		},
	},
] satisfies readonly {
	readonly name: string;
	readonly environment: Readonly<NodeJS.ProcessEnv>;
}[]);

for (const topology of AGENT_EXECUTION_TOPOLOGIES) test(
		`Node backend runs a spawned subagent with ${topology.name}`, {
		timeout: 20_000,
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
			...topology.environment,
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
	try {
		await waitFor(() => messages.find((message) => (
			message.method === "subagent.updated"
			&& (message.params as { subagent?: { status?: string } } | undefined)?.subagent?.status === "completed"
		)), 10_000);
	} catch {
		assert.fail(JSON.stringify(messages.flatMap((message) => {
			if (typeof message.method !== "string") return [];
			const subagent = (message.params as {
				readonly subagent?: { readonly status?: unknown };
			} | undefined)?.subagent;
			return [{
				method: message.method,
				status: typeof subagent?.status === "string" ? subagent.status : undefined,
				code: paramValue(message, "code") ?? errorValue(message, "code"),
			}];
		})));
	}
	assert.equal(parentRequests.length, 2);
	assert.equal(childRequests.length, 1);
	assert.deepEqual(toolNames(childRequests[0]?.tools), [
		"Read", "Edit", "Patch", "Write", "update_plan", "web_fetch",
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
		/Tool scope: Edit, Patch, Read, Skill, Write, tool_search, update_plan, web_fetch/u,
	);
	assert.match(childDeveloperContext, /Permission profile: workspace/u);
	assert.match(childDeveloperContext, /Sandbox mode: workspace-write/u);
	assert.deepEqual(childInput.at(-1), { role: "user", content: "Inspect the repository." });
	const subagentEvents = messages.filter((message) => message.method === "subagent.updated");
	assert.deepEqual(subagentEvents.map((message) => (
		(message.params as { subagent: { status: string } }).subagent.status
	)), ["running", "completed"]);
	assert.equal(JSON.stringify(subagentEvents).includes("Child inspected repository"), false);
	writeRequest(backend, "child-trace", "trace.export", { tail: 50 });
	const trace = await waitFor(() => response(messages, "child-trace"));
	const lifecycleDiagnostics = (resultValue(trace, "rows") as readonly string[])
		.map((row) => JSON.parse(row) as Record<string, unknown>)
		.filter((row) => row.kind === "subagent_lifecycle");
	assert.deepEqual(lifecycleDiagnostics.map((row) => (
		(row.payload as Record<string, unknown>).status
	)), ["started", "completed"]);
	assert.equal(JSON.stringify(lifecycleDiagnostics).includes("Child inspected repository"), false);

	writeRequest(backend, "shutdown-child", "shutdown", {});
	assert.equal(await backend.completion, 0);
	const store = openRuntimeSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
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
		const parentManifest = store.modelInputLedger.loadLatestProviderRequestManifest(
			"parent-session",
		);
		assert.ok(parentManifest);
		assert.deepEqual(
			store.modelInputLedger.reconstructProviderStep(parentManifest.requestId).request.model,
			"gpt-test",
		);
		assert.deepEqual(
			store.loadConversationItems("parent-session").map((item) => item.type),
			["user", "assistant_tool_calls", "tool_result", "assistant"],
		);
		const parentInstructions = store.modelInputLedger.loadLatestInstructionSnapshot("parent-session");
		const childInstructions = store.modelInputLedger.loadLatestInstructionSnapshot(childSessionId);
		assert.equal(childInstructions?.contentSha256, parentInstructions?.contentSha256);
		const childManifest = store.modelInputLedger.loadLatestProviderRequestManifest(childSessionId);
		assert.ok(childManifest);
		assert.notEqual(childManifest.requestId, parentManifest.requestId);
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

test("Node backend interrupts one Worker-backed child while root and sibling complete", {
	timeout: 15_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-child-interrupt-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	const parentRequests: Record<string, unknown>[] = [];
	const targetRequests: Record<string, unknown>[] = [];
	const siblingRequests: Record<string, unknown>[] = [];
	let targetResponse: ServerResponse | undefined;
	let siblingResponse: ServerResponse | undefined;
	let signalTargetStarted!: () => void;
	let signalSiblingStarted!: () => void;
	const targetStarted = new Promise<void>((resolve) => { signalTargetStarted = resolve; });
	const siblingStarted = new Promise<void>((resolve) => { signalSiblingStarted = resolve; });
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			const payload = JSON.parse(body) as Record<string, unknown>;
			const input = JSON.stringify(payload.input);
			response.writeHead(200, { "content-type": "text/event-stream" });
			const finishTool = (
				callId: string,
				name: string,
				argumentsValue: Readonly<Record<string, unknown>>,
			): void => {
				response.write(`data: ${JSON.stringify({
					type: "response.output_item.done",
					item: {
						type: "function_call",
						call_id: callId,
						name,
						arguments: JSON.stringify(argumentsValue),
					},
				})}\n\n`);
				response.write(`data: ${JSON.stringify({
					type: "response.completed",
					response: { id: `resp-${callId}` },
				})}\n\n`);
				response.end("data: [DONE]\n\n");
			};
			const finishText = (text: string, responseId: string): void => {
				response.write(`data: ${JSON.stringify({
					type: "response.output_text.delta",
					delta: text,
				})}\n\n`);
				response.write(`data: ${JSON.stringify({
					type: "response.completed",
					response: { id: responseId },
				})}\n\n`);
				response.end("data: [DONE]\n\n");
			};
			if (isSubagentRequest(payload)) {
				if (input.includes("Complete independently.")) {
					siblingRequests.push(payload);
					siblingResponse = response;
					signalSiblingStarted();
				} else {
					targetRequests.push(payload);
					targetResponse = response;
					signalTargetStarted();
				}
				return;
			}

			parentRequests.push(payload);
			if (parentRequests.length === 1) {
				finishTool("call-spawn-interrupt-worker", "spawn_agent", {
					task_name: "worker",
					message: "Wait for interruption.",
				});
				return;
			}
			if (parentRequests.length === 2) {
				finishTool("call-spawn-interrupt-sibling", "spawn_agent", {
					task_name: "sibling",
					message: "Complete independently.",
				});
				return;
			}
			if (parentRequests.length === 3) {
				void Promise.all([targetStarted, siblingStarted]).then(() => finishTool(
					"call-interrupt-worker",
					"interrupt_agent",
					{
					target: "/root/worker",
					reason: "targeted integration interruption",
					},
				));
				return;
			}
			if (input.includes("Sibling completed independently.")) {
				finishText(
					"Parent and sibling remained active after child interruption.",
					"resp-parent-after-child-interrupt",
				);
				return;
			}
			finishTool(
				`call-wait-interrupt-sibling-${parentRequests.length}`,
				"wait_agent",
				{ timeout_ms: 5_000 },
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "child-interrupt-parent", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
			MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
		},
	});
	t.after(async () => {
		targetResponse?.destroy();
		siblingResponse?.destroy();
		await backend.close().catch(() => undefined);
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
	writeRequest(backend, "start-child-interruption", "turn.submit", {
		message: "Spawn and interrupt one child.",
		client_turn_id: "child-interrupt-parent-turn",
		client_user_message_id: "child-interrupt-parent-message",
	});
	await Promise.all([targetStarted, siblingStarted]);

	await waitFor(() => messages.find((message) => (
		message.method === "subagent.updated"
		&& (paramValue(message, "subagent") as Record<string, unknown> | undefined)
			?.status === "interrupted"
	)), 10_000);
	assert.equal(messages.some((message) => (
		message.method === "subagent.updated"
		&& (paramValue(message, "subagent") as Record<string, unknown> | undefined)
			?.status === "completed"
	)), false);
	assert.ok(siblingResponse);
	siblingResponse.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Sibling completed independently.\"}\n\n");
	siblingResponse.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-interrupt-sibling-complete\"}}\n\n");
	siblingResponse.end("data: [DONE]\n\n");
	await waitFor(() => messages.find((message) => (
		message.method === "subagent.updated"
		&& (paramValue(message, "subagent") as Record<string, unknown> | undefined)
			?.status === "completed"
	)), 10_000);
	await waitFor(() => messages.find((message) => (
		message.method === "message.complete"
		&& paramValue(message, "final") === true
		&& paramValue(message, "text")
			=== "Parent and sibling remained active after child interruption."
	)), 10_000);
	assert.equal(parentRequests.length >= 5, true);
	assert.equal(targetRequests.length, 1);
	assert.equal(siblingRequests.length, 1);
	assert.equal(messages.filter((message) => (
		message.method === "subagent.updated"
		&& (paramValue(message, "subagent") as Record<string, unknown> | undefined)
			?.status === "interrupted"
	)).length, 1);

	writeRequest(backend, "shutdown-child-interruption", "shutdown", {});
	assert.equal(await backend.completion, 0);
	const store = openRuntimeSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		const tasks = store.subagentTasks.list("child-interrupt-parent");
		assert.equal(tasks.length, 2);
		const target = tasks.find((task) => task.payload.description === "Wait for interruption.");
		const sibling = tasks.find((task) => task.payload.description === "Complete independently.");
		assert.equal(target?.status, "interrupted");
		assert.equal(sibling?.status, "completed");
		assert.equal(sibling?.payload.report, "Sibling completed independently.");
		assert.ok(target);
		assert.equal(store.agentThreads.get(target.childSessionId)?.status, "interrupted");
		assert.equal(store.loadConversationItems(target.childSessionId).filter((item) => (
			item.type === "context" && item.metadata.kind === "turn_aborted"
		)).length, 1);
		assert.ok(sibling);
		assert.equal(store.agentThreads.get(sibling.childSessionId)?.status, "unloaded");
		assert.match(
			JSON.stringify(store.loadConversationItems(sibling.childSessionId)),
			/Sibling completed independently\./u,
		);
	} finally {
		store.close();
	}
});

test("Node backend rejects AskUserQuestion from a Default-mode Worker child", {
	timeout: 10_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-child-clarification-"));
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
				if (childRequests.length === 1) {
					response.write(`data: ${JSON.stringify({
						type: "response.output_item.done",
						item: {
							type: "function_call",
							call_id: "call-child-question",
							name: "AskUserQuestion",
							arguments: JSON.stringify({
								question: "Which file should the child inspect?",
								options: [{ label: "README" }, { label: "package.json" }],
								header: "File",
								multi_select: false,
							}),
						},
					})}\n\n`);
					response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-child-question\"}}\n\n");
				} else {
					response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Child continued without clarification.\"}\n\n");
					response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-child-clarified\"}}\n\n");
				}
			} else {
				parentRequests.push(payload);
				if (parentRequests.length === 1) {
					response.write(`data: ${JSON.stringify({
						type: "response.output_item.done",
						item: {
							type: "function_call",
							call_id: "call-spawn-clarification-child",
							name: "spawn_agent",
							arguments: JSON.stringify({
								task_name: "clarify-worker",
								message: "Ask which file to inspect.",
							}),
						},
					})}\n\n`);
					response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-parent-clarify-spawn\"}}\n\n");
				} else if (parentRequests.length === 2) {
					response.write(`data: ${JSON.stringify({
						type: "response.output_item.done",
						item: {
							type: "function_call",
							call_id: "call-wait-clarification-child",
							name: "wait_agent",
							arguments: JSON.stringify({ timeout_ms: 5_000 }),
						},
					})}\n\n`);
					response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-parent-clarify-wait\"}}\n\n");
				} else {
					response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"Parent received child report.\"}\n\n");
					response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-parent-clarified\"}}\n\n");
				}
			}
			response.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	t.after(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		});
		await rm(root, { recursive: true, force: true });
	});
	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "child-clarification-parent", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
			MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
		},
	});
	t.after(async () => {
		await backend.close().catch(() => undefined);
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	writeRequest(backend, "start-child-clarification", "turn.submit", {
		message: "Delegate a question attempt to a child.",
		client_turn_id: "child-clarification-parent-turn",
		client_user_message_id: "child-clarification-parent-message",
	});
	await waitFor(() => messages.find((message) => (
		message.method === "message.complete"
		&& paramValue(message, "final") === true
		&& paramValue(message, "text") === "Parent received child report."
	)), 7_000);
	assert.equal(childRequests.length, 2, JSON.stringify({
		parentInputs: parentRequests.map((payload) => payload.input),
		childInputs: childRequests.map((payload) => payload.input),
	}, null, 2).slice(0, 12_000));
	assert.equal(messages.some((message) => message.method === "clarify.request"), false);
	assert.equal(toolNames(childRequests[0]?.tools).includes("AskUserQuestion"), false);
	assert.match(JSON.stringify(childRequests[1]?.input), /unsupported call: AskUserQuestion/u);
	writeRequest(backend, "shutdown-child-clarification", "shutdown", {});
	assert.equal(await backend.completion, 0);
	const store = openRuntimeSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		const task = store.subagentTasks.list("child-clarification-parent")[0];
		assert.equal(task?.status, "completed");
		assert.equal(task?.payload.report, "Child continued without clarification.");
		assert.equal(store.loadState(String(task?.childSessionId), "suspended_turn"), undefined);
	} finally {
		store.close();
	}
});

test("Node backend runs a root turn with isolated concurrent child Workers", {
	timeout: 15_000,
}, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-concurrent-children-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	await Promise.all([
		writeFile(join(workspace, "concurrent.txt"), "reader-only-content\n", "utf8"),
		writeFile(
			join(workspace, "concurrent-child.cjs"),
			"process.stdout.write('concurrent-shell-ok\\n');\n",
			"utf8",
		),
	]);
	const command = `"${process.execPath}" concurrent-child.cjs`;
	const parentRequests: Record<string, unknown>[] = [];
	const askerRequests: Record<string, unknown>[] = [];
	const readerRequests: Record<string, unknown>[] = [];
	let activeInitialChildren = 0;
	let maximumActiveInitialChildren = 0;
	let releaseInitialChildren!: () => void;
	const initialChildrenReleased = new Promise<void>((resolve) => {
		releaseInitialChildren = resolve;
	});
	let signalChildrenReady!: () => void;
	const childrenReady = new Promise<void>((resolve) => { signalChildrenReady = resolve; });
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			const payload = JSON.parse(body) as Record<string, unknown>;
			const input = JSON.stringify(payload.input);
			response.writeHead(200, { "content-type": "text/event-stream" });
			const finishText = (
				text: string,
				responseId: string,
				usage: Readonly<Record<string, number>>,
			): void => {
				response.write(`data: ${JSON.stringify({
					type: "response.output_text.delta",
					delta: text,
				})}\n\n`);
				response.write(`data: ${JSON.stringify({
					type: "response.completed",
					response: { id: responseId, usage },
				})}\n\n`);
				response.end("data: [DONE]\n\n");
			};
			const finishTool = (
				callId: string,
				name: string,
				argumentsValue: Readonly<Record<string, unknown>>,
				responseId: string,
				usage: Readonly<Record<string, number>> = {},
			): void => {
				response.write(`data: ${JSON.stringify({
					type: "response.output_item.done",
					item: {
						type: "function_call",
						call_id: callId,
						name,
						arguments: JSON.stringify(argumentsValue),
					},
				})}\n\n`);
				response.write(`data: ${JSON.stringify({
					type: "response.completed",
					response: { id: responseId, usage },
				})}\n\n`);
				response.end("data: [DONE]\n\n");
			};
			const childRequest = isSubagentRequest(payload);
			const isAsker = childRequest && (input.includes("Ask for shell approval in the child.")
				|| input.includes("call-concurrent-shell"));
			const isReader = childRequest && (input.includes("Read concurrent.txt in the child.")
				|| input.includes("call-concurrent-read"));
			if (isAsker) {
				askerRequests.push(payload);
				if (askerRequests.length === 1) {
					activeInitialChildren += 1;
					maximumActiveInitialChildren = Math.max(
						maximumActiveInitialChildren,
						activeInitialChildren,
					);
					if (activeInitialChildren === 2) signalChildrenReady();
					void initialChildrenReleased.then(() => {
						activeInitialChildren -= 1;
						finishTool(
							"call-concurrent-shell",
							"Shell",
							{
								command,
								yield_time_ms: 3_000,
								sandbox_permissions: "require_escalated",
							},
							"resp-concurrent-shell-tool",
							{ input_tokens: 1, output_tokens: 2, total_tokens: 3 },
						);
					});
					return;
				}
				finishText(
					"Asker child report.",
					"resp-concurrent-asker-final",
					{ input_tokens: 4, output_tokens: 5, total_tokens: 9 },
				);
				return;
			}
			if (isReader) {
				readerRequests.push(payload);
				if (readerRequests.length === 1) {
					activeInitialChildren += 1;
					maximumActiveInitialChildren = Math.max(
						maximumActiveInitialChildren,
						activeInitialChildren,
					);
					if (activeInitialChildren === 2) signalChildrenReady();
					void initialChildrenReleased.then(() => {
						activeInitialChildren -= 1;
						finishTool(
							"call-concurrent-read",
							"Read",
							{ file_path: "concurrent.txt", offset: 1, limit: 20 },
							"resp-concurrent-read-tool",
							{ input_tokens: 10, output_tokens: 11, total_tokens: 21 },
						);
					});
					return;
				}
				finishText(
					"Reader child report.",
					"resp-concurrent-reader-final",
					{ input_tokens: 12, output_tokens: 13, total_tokens: 25 },
				);
				return;
			}

			parentRequests.push(payload);
			if (parentRequests.length === 1) {
				finishTool("call-spawn-concurrent-asker", "spawn_agent", {
					task_name: "asker",
					message: "Ask for shell approval in the child.",
				}, "resp-spawn-concurrent-asker");
				return;
			}
			if (parentRequests.length === 2) {
				finishTool("call-spawn-concurrent-reader", "spawn_agent", {
					task_name: "reader",
					message: "Read concurrent.txt in the child.",
				}, "resp-spawn-concurrent-reader");
				return;
			}
			if (input.includes("Asker child report.")
				&& input.includes("Reader child report.")) {
				finishText("Root received both child reports.", "resp-concurrent-root-final", {});
				return;
			}
			finishTool(
				`call-wait-concurrent-${parentRequests.length}`,
				"wait_agent",
				{ timeout_ms: 5_000 },
				`resp-wait-concurrent-${parentRequests.length}`,
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	t.after(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		});
		await rm(root, { recursive: true, force: true });
	});
	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "concurrent-parent", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
			MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
		},
	});
	t.after(async () => {
		releaseInitialChildren();
		await backend.close().catch(() => undefined);
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	writeRequest(backend, "trust-concurrent-children", "workspace.trust.set", { state: "trusted" });
	await waitFor(() => response(messages, "trust-concurrent-children"));
	writeRequest(backend, "permission-concurrent-children", "permissions.update", {
		profile: "workspace",
	});
	await waitFor(() => response(messages, "permission-concurrent-children"));
	writeRequest(backend, "start-concurrent-children", "turn.submit", {
		message: "Run two child agents concurrently and wait for both.",
		client_turn_id: "concurrent-parent-turn",
		client_user_message_id: "concurrent-parent-message",
	});
	await childrenReady;
	await waitFor(() => messages.find((message) => (
		message.method === "tool.start" && paramValue(message, "name") === "wait_agent"
	)), 5_000);
	assert.equal(maximumActiveInitialChildren, 2);
	assert.equal(finalMessageCount(messages), 0);
	releaseInitialChildren();

	const approval = await waitFor(() => messages.find((message) => (
		message.method === "approval.request"
		&& paramValue(message, "session_id") !== "concurrent-parent"
	)), 5_000);
	writeRequest(backend, "approve-concurrent-child", "approval.respond", {
		session_id: paramValue(approval, "session_id"),
		generation: paramValue(approval, "generation"),
		decision_id: paramValue(approval, "decision_id"),
		choice: "approve_once",
	});
	const approved = await waitFor(() => response(messages, "approve-concurrent-child"));
	assert.equal(resultValue(approved, "accepted"), true);
	await waitFor(() => messages.find((message) => (
		message.method === "message.complete"
		&& paramValue(message, "final") === true
		&& paramValue(message, "text") === "Root received both child reports."
	)), 10_000);
	await waitFor(() => messages.filter((message) => (
		message.method === "subagent.updated"
		&& (paramValue(message, "subagent") as Record<string, unknown> | undefined)
			?.status === "completed"
	)).length === 2, 10_000);
	assert.equal(askerRequests.length, 2);
	assert.equal(readerRequests.length, 2);
	assert.match(JSON.stringify(askerRequests[1]?.input), /concurrent-shell-ok/u);
	assert.doesNotMatch(JSON.stringify(askerRequests), /reader-only-content/u);
	assert.match(JSON.stringify(readerRequests[1]?.input), /reader-only-content/u);
	assert.doesNotMatch(JSON.stringify(readerRequests), /concurrent-shell-ok/u);

	writeRequest(backend, "shutdown-concurrent-children", "shutdown", {});
	assert.equal(await backend.completion, 0);
	const store = openRuntimeSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	try {
		const tasks = store.subagentTasks.list("concurrent-parent");
		assert.equal(tasks.length, 2);
		const asker = tasks.find((task) => task.payload.description?.includes("shell approval"));
		const reader = tasks.find((task) => task.payload.description?.includes("concurrent.txt"));
		assert.equal(asker?.status, "completed");
		assert.equal(reader?.status, "completed");
		assert.equal(asker?.payload.report, "Asker child report.");
		assert.equal(reader?.payload.report, "Reader child report.");
		assert.deepEqual(asker?.payload.usage, {
			input_tokens: 5,
			output_tokens: 7,
			total_tokens: 12,
		});
		assert.deepEqual(reader?.payload.usage, {
			input_tokens: 22,
			output_tokens: 24,
			total_tokens: 46,
		});
		assert.ok(asker);
		assert.ok(reader);
		const askerConversation = JSON.stringify(store.loadConversationItems(asker.childSessionId));
		const readerConversation = JSON.stringify(store.loadConversationItems(reader.childSessionId));
		assert.match(askerConversation, /concurrent-shell-ok/u);
		assert.doesNotMatch(askerConversation, /reader-only-content/u);
		assert.match(readerConversation, /reader-only-content/u);
		assert.doesNotMatch(readerConversation, /concurrent-shell-ok/u);
		assert.equal(store.loadState(asker.childSessionId, "pending_decision"), undefined);
		assert.ok(store.modelInputLedger.loadLatestProviderRequestManifest(asker.childSessionId));
		assert.ok(store.modelInputLedger.loadLatestProviderRequestManifest(reader.childSessionId));
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
			MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
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
	const waitingStore = openRuntimeSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
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
	const completedStore = openRuntimeSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
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
	const store = openRuntimeSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
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
			MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
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
	const store = openRuntimeSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
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
			MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
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
	const liveStore = openRuntimeSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
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
	const store = openRuntimeSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
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
	const seed = openRuntimeSessionStore({ dbPath });
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
	const reopened = openRuntimeSessionStore({ dbPath });
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
	const seed = openRuntimeSessionStore({ dbPath });
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
	const reopened = openRuntimeSessionStore({ dbPath });
	try {
		assert.equal(reopened.loadHistoryItems("subagent-recovery").filter((item) => (
			(item.metadata as Readonly<Record<string, unknown>> | undefined)?.source
				=== "task_notification"
		)).length, 1);
	} finally {
		reopened.close();
	}
});

test("Node backend resumes a session whose completed subagent has a blank report", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-blank-subagent-resume-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	const dbPath = join(home, ".mycli", "sessions.db");
	const parentSessionId = "blank-report-parent";
	const childSessionId = "blank-report-child";
	const taskId = "blank-report-task";
	const seed = openRuntimeSessionStore({ dbPath });
	try {
		seedCompletedSession(seed, workspace, parentSessionId, "seed question", "seed answer");
		const parent = seed.loadSession(parentSessionId);
		assert.ok(parent);
		seed.agentThreads.reserve({
			threadId: childSessionId,
			rootThreadId: parent.threadId,
			parentThreadId: parent.threadId,
			parentPath: rootAgentPath(),
			taskName: "blank-report",
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
			sourceSessionId: parentSessionId,
			targetSessionId: childSessionId,
			workspaceRoot: workspace,
			targetThreadId: childSessionId,
			forkTurns: "none",
		});
		seed.agentThreads.transition({ threadId: childSessionId, status: "running" });
		const ownership = {
			taskId,
			parentSessionId,
			childSessionId,
		};
		seed.subagentTasks.reserve({
			...ownership,
			parentTurnId: "blank-report-parent-turn",
			profileId: "subagent",
			mode: "background",
			description: "Return no final text.",
		});
		seed.subagentTasks.markRunning(ownership);
		seed.subagentTasks.complete({
			...ownership,
			report: "",
			outputReference: `subagent-task:${taskId}`,
		});
		seed.agentThreads.transition({ threadId: childSessionId, status: "idle" });
		seed.agentThreads.transition({ threadId: childSessionId, status: "unloaded" });
	} finally {
		seed.close();
	}

	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "blank-report-source", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: "http://127.0.0.1:9/v1",
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_MEMORY_ENABLED: "false",
		},
	});
	t.after(async () => { await backend.close(); });
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	writeRequest(backend, "blank-report-resume", "session.resume", {
		session_id: parentSessionId,
	});
	const resumed = await waitFor(() => response(messages, "blank-report-resume"));
	assert.equal(errorValue(resumed, "code"), undefined);
	assert.equal(resultValue(resumed, "session_id"), parentSessionId);

	writeRequest(backend, "blank-report-shutdown", "shutdown", {});
	assert.equal(await backend.completion, 0);
	const reopened = openRuntimeSessionStore({ dbPath });
	try {
		const parent = reopened.loadSession(parentSessionId);
		assert.ok(parent);
		const completion = reopened.agentMailbox.list({ receiverThreadId: parent.threadId })
			.find((item) => item.sourceCallId === taskId);
		assert.deepEqual(completion?.payload, {
			kind: "completion",
			status: "completed",
			report: "Subagent completed",
			outputReference: `subagent-task:${taskId}`,
		});
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

test("Worker-backed root exposes Shell only on turns accepted after workspace trust", async (t) => {
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
			requestTools.push(providerToolNames(payload.tools));
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
			MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
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
		"Read", "Edit", "Patch", "Write", "update_plan", "web_fetch",
		"tool_search", "Skill",
		"spawn_agent", "send_message", "followup_task", "interrupt_agent", "list_agents",
		"wait_agent", "web_search",
	]);
	assert.deepEqual(requestTools[1], [
		"Read", "Edit", "Patch", "Write", "update_plan", "web_fetch",
		"tool_search", "Shell", "WriteStdin", "Skill", "spawn_agent", "send_message",
		"followup_task", "interrupt_agent", "list_agents", "wait_agent", "web_search",
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

test("Worker-backed root atomically resumes complete persisted session state", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-resume-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(home);
	await mkdir(workspace);
	const dbPath = join(home, ".mycli", "sessions.db");
	const seed = openRuntimeSessionStore({ dbPath });
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
			MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
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
	assert.deepEqual(paramValue(approvalEvent, "permission_request"), {
		network: { enabled: true },
	});
	writeRequest(backend, "approval-reject", "approval.respond", {
		decision_id: "call-approval",
		choice: "reject",
	});
	const approvalRejected = await waitFor(() => response(messages, "approval-reject"));
	assert.equal(resultValue(approvalRejected, "accepted"), true);
	const approvalCompleted = await waitFor(() => messages.find((message) => {
		if (message.method !== "turn.completed") return false;
		const params = message.params as Record<string, unknown> | undefined;
		return params?.client_turn_id === "approval-client-approval";
	}));
	await waitFor(() => messages.find((message, index) => (
		index > messages.indexOf(approvalCompleted)
		&& message.method === "status.changed"
		&& paramValue(message, "session_id") === "approval"
		&& paramValue(message, "turn_running") === false
	)));

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
	const reopened = openRuntimeSessionStore({ dbPath });
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
	const seed = openRuntimeSessionStore({ dbPath });
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

	const reopened = openRuntimeSessionStore({ dbPath });
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

test("Worker-backed root retains provider-free slash commands in the coordinator", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-command-services-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	const dbPath = join(home, ".mycli", "sessions.db");
	const seed = openRuntimeSessionStore({ dbPath });
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
	await mkdir(join(home, ".mycli", "traces"), { recursive: true });
	await writeFile(
		join(home, ".mycli", "traces", "search-source-trace.jsonl"),
		`${JSON.stringify({
			kind: "model_stream_diagnostics",
			turn_id: "seed-turn-search-source",
			payload: {
				provider: "openai",
				protocol: "responses",
				model: "gpt-test",
				attempt: 1,
				elapsed_ms: 25,
				provider_event_count: 1,
				reasoning_event_count: 0,
				text_event_count: 0,
				provider_state_event_count: 0,
				tool_call_event_count: 0,
				usage_event_count: 0,
				completed_event_count: 1,
				reasoning_bytes: 0,
				text_bytes: 0,
				success: true,
				prompt: "api_key=private-value",
			},
		})}\n`,
		"utf8",
	);
	await writeFile(
		join(home, ".mycli", "traces", "command-session-trace.jsonl"),
		"x".repeat(5 * 1024 * 1024 + 1),
		"utf8",
	);
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
			MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
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
	writeRequest(backend, "command-trace", "trace.export", { tail: 20 });
	const commandTrace = await waitFor(() => response(messages, "command-trace"));
	const commandDiagnostics = (resultValue(commandTrace, "rows") as readonly string[])
		.map((row) => JSON.parse(row) as Record<string, unknown>);
	assert.equal(commandDiagnostics.some((row) => (
		row.kind === "compaction"
		&& (row.payload as Record<string, unknown>).source === "user_requested"
		&& (row.payload as Record<string, unknown>).status === "not_needed"
	)), true);
	assert.equal(existsSync(join(
		home,
		".mycli",
		"traces",
		"command-session-trace.jsonl.1",
	)), true);
	const tasks = await runCommand("/tasks agents");
	assert.equal(displayValue(tasks, "title"), "Background agents");
	assert.equal(displayValue(tasks, "total_rows"), 0);

	const search = await runCommand("/session search parity needle");
	assert.equal(displayValue(search, "kind"), "list");
	assert.match(JSON.stringify(displayValue(search, "rows")), /search-source/u);
	const maintenance = await runCommand("/session maintenance");
	assert.equal(displayValue(maintenance, "title"), "Session maintenance");
	assert.equal(displayValue(maintenance, "kind"), "list");
	assert.match(JSON.stringify(displayValue(maintenance, "rows")), /Transcript normalization status/u);

	const resume = await runCommand("/resume search-source");
	assert.equal(resultValue(resume, "mutated_session"), true);
	assert.equal(resultValue(resume, "session_id"), "search-source");
	const trace = await runCommand("/trace");
	assert.equal(displayValue(trace, "title"), "Trace");
	assert.match(JSON.stringify(displayValue(trace, "rows")), /seed-turn-search-source/u);
	assert.match(JSON.stringify(displayValue(trace, "rows")), /model_stream_diagnostics/u);
	assert.equal(JSON.stringify(displayValue(trace, "rows")).includes("private-value"), false);
	const fork = await runCommand("/fork search-source forked-session 2");
	assert.equal(resultValue(fork, "mutated_session"), true);
	assert.equal(resultValue(fork, "session_id"), "forked-session");

	const normalizedResult = await runCommand("/session maintenance --apply-transcript-normalization");
	assert.equal(displayValue(normalizedResult, "kind"), "notice");
	assert.equal(resultValue(normalizedResult, "phase"), "complete");
	assert.equal(resultValue(normalizedResult, "status"), "already_normalized");
	assert.equal(resultValue(normalizedResult, "schema_version"), 12);
	writeRequest(backend, "provider-free-shutdown", "shutdown", {});
	assert.equal(await backend.completion, 0);
	const normalized = openRuntimeSessionStore({ dbPath });
	try {
		assert.ok(normalized.loadConversation("search-source").length > 0);
	} finally {
		normalized.close();
	}
});

test("Node backend reports v12 content blobs complete and collects explicit orphans", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-content-blob-maintenance-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(home), mkdir(workspace)]);
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	const dbPath = join(home, ".mycli", "sessions.db");
	const seed = openRuntimeSessionStore({ dbPath });
	seed.importLegacyConversation({
		sessionId: "content-session",
		workspaceRoot: workspace,
		threadId: "content-session",
		messages: [{ role: "assistant", content: "private backend content payload ".repeat(500) }],
	});
	seed.close();

	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "content-session", "--model", "gpt-test"],
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
		const id = `content-command-${requestNumber}`;
		writeRequest(backend, id, "command.run", { command, surface: "tui" });
		return await waitFor(() => response(messages, id));
	};

	const report = await runCommand("/session maintenance");
	assert.match(
		JSON.stringify(displayValue(report, "rows")),
		/Content blob migration status/u,
	);
	const complete = await runCommand("/session maintenance --apply-content-blobs");
	assert.equal(resultValue(complete, "phase"), "complete");
	assert.equal(resultValue(complete, "status"), "already_blob_backed");
	assert.equal(resultValue(complete, "schema_version"), 12);
	assert.doesNotMatch(JSON.stringify(complete), /private backend content|content-event/u);

	const orphan = encodeSessionContentBlob("private backend orphan ".repeat(500));
	const orphanDatabase = new DatabaseSync(dbPath);
	orphanDatabase.prepare(`
		INSERT INTO session_content_blobs (
			blob_id, codec, raw_bytes, stored_bytes, payload_blob, created_at
		) VALUES (?, ?, ?, ?, ?, ?)
	`).run(
		orphan.blobId,
		orphan.codec,
		orphan.rawBytes,
		orphan.storedBytes,
		orphan.payload,
		"2026-08-15T00:00:00.000Z",
	);
	orphanDatabase.close();
	writeRequest(backend, "content-gc", "command.run", {
		command: "/session maintenance --apply-content-blob-gc",
		surface: "tui",
	});
	const collected = await waitFor(() => response(messages, "content-gc"));
	assert.equal(resultValue(collected, "status"), "collected");
	assert.equal(resultValue(collected, "deletedBlobCount"), 1);
	assert.equal(resultValue(collected, "deletedRawBytes"), orphan.rawBytes);
	assert.doesNotMatch(JSON.stringify(collected), /private backend orphan|sha256:/u);
	writeRequest(backend, "content-gc-shutdown", "shutdown", {});
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
		version: 2,
		providers: {
			openai: {
			protocol: "responses",
			base_url: "https://example.invalid/v1",
			auth_ref: "catalog-account",
			options: { store: false },
			models: {
				"gpt-selected": {
					description: "Integration catalog model",
					limits: {
						context_window_tokens: 200_000,
						max_output_tokens: 50_000,
					},
					reasoning: {
						efforts: ["low", "high"],
						default: "low",
					},
				},
			},
			},
		},
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
	assert.equal(bootstrapModels[0]?.context_window_tokens, 200_000);
	assert.equal(bootstrapModels[0]?.max_output_tokens, 50_000);

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
	const selected = resultValue(model, "selected") as Record<string, unknown>;
	assert.equal(selected.model, "gpt-selected");
	assert.equal(selected.context_window_tokens, 200_000);
	assert.equal(selected.max_output_tokens, 50_000);
	writeRequest(first, "bootstrap-selected", "session.bootstrap", { protocol_version: 1 });
	const selectedBootstrap = await waitFor(() => response(firstMessages, "bootstrap-selected"));
	const selectedStatus = resultValue(selectedBootstrap, "status") as Record<string, unknown>;
	assert.equal(
		(selectedStatus.context_window as Record<string, unknown>).max_tokens,
		150_000,
	);

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

test("Node backend restores model effort and mode from each session preference", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-session-preferences-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await Promise.all([mkdir(join(home, ".mycli"), { recursive: true }), mkdir(workspace)]);
	await writeFile(join(home, ".mycli", "auth.json"), `${JSON.stringify({
		"session-account": { type: "api_key", key: "session-secret" },
	}, null, 2)}\n`, "utf8");
	await writeFile(join(home, ".mycli", "models.json"), `${JSON.stringify({
		version: 2,
		providers: {
			openai: {
				protocol: "responses",
				base_url: "https://session.invalid/v1",
				auth_ref: "session-account",
				models: {
					"gpt-session-a": { reasoning: { efforts: ["low", "high"], default: "low" } },
					"gpt-session-b": { reasoning: { efforts: ["none"], default: "none" } },
				},
			},
		},
	}, null, 2)}\n`, "utf8");
	t.after(async () => { await rm(root, { recursive: true, force: true }); });
	const options = {
		cwd: workspace,
		args: ["--session", "session-a"],
		env: { HOME: home },
	} as const;

	const first = await startNodeBackend(options);
	const firstMessages: Array<Record<string, unknown>> = [];
	createInterface({ input: first.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		firstMessages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(firstMessages, "runtime.ready"));
	writeRequest(first, "select-a", "model.select", {
		provider: "openai",
		protocol: "responses",
		model: "gpt-session-a",
		base_url: "https://session.invalid/v1",
		reasoning_effort: "high",
	});
	await waitFor(() => response(firstMessages, "select-a"));
	writeRequest(first, "mode-a", "command.run", { command: "/mode plan", surface: "tui" });
	await waitFor(() => response(firstMessages, "mode-a"));

	writeRequest(first, "new-b", "session.new", {});
	const created = await waitFor(() => response(firstMessages, "new-b"));
	const sessionB = String(resultValue(created, "session_id"));
	writeRequest(first, "select-b", "model.select", {
		provider: "openai",
		protocol: "responses",
		model: "gpt-session-b",
		base_url: "https://session.invalid/v1",
		reasoning_effort: "none",
	});
	await waitFor(() => response(firstMessages, "select-b"));
	writeRequest(first, "mode-b", "command.run", { command: "/mode default", surface: "tui" });
	await waitFor(() => response(firstMessages, "mode-b"));

	writeRequest(first, "resume-a", "session.resume", { session_id: "session-a" });
	await waitFor(() => response(firstMessages, "resume-a"));
	writeRequest(first, "status-a", "status.inspect", {});
	const activeA = await waitFor(() => response(firstMessages, "status-a"));
	assert.equal(resultValue(activeA, "model"), "gpt-session-a");
	assert.equal(resultValue(activeA, "thinking_effort"), "high");
	assert.equal(resultValue(activeA, "collaboration_mode"), "plan");

	writeRequest(first, "new-fallback", "session.new", {});
	await waitFor(() => response(firstMessages, "new-fallback"));
	writeRequest(first, "status-fallback", "status.inspect", {});
	const fallback = await waitFor(() => response(firstMessages, "status-fallback"));
	assert.equal(resultValue(fallback, "model"), "gpt-session-b");
	assert.equal(resultValue(fallback, "thinking_effort"), "none");
	assert.equal(resultValue(fallback, "collaboration_mode"), "default");
	writeRequest(first, "shutdown-session-preferences", "shutdown", {});
	assert.equal(await first.completion, 0);

	const store = openRuntimeSessionStore({ dbPath: join(home, ".mycli", "sessions.db") });
	const sessionA = store.loadState("session-a", "session_preferences") as Record<string, unknown>;
	const storedB = store.loadState(sessionB, "session_preferences") as Record<string, unknown>;
	assert.deepEqual(
		[sessionA.model, sessionA.reasoning_effort, sessionA.collaboration_mode],
		["gpt-session-a", "high", "plan"],
	);
	assert.deepEqual(
		[storedB.model, storedB.reasoning_effort, storedB.collaboration_mode],
		["gpt-session-b", "none", "default"],
	);
	assert.equal(JSON.stringify([sessionA, storedB]).includes("session-secret"), false);
	store.saveState({
		sessionId: "session-corrupt",
		workspaceRoot: workspace,
		threadId: "session-corrupt",
		key: "session_preferences",
		payload: {
			state_version: 1,
			provider: "openai",
			protocol: "responses",
			model: "gpt-corrupt",
			api_base_url: "not-a-url",
			auth_ref: "session-account",
			reasoning_effort: "high",
			collaboration_mode: "plan",
		},
	});
	store.close();

	const second = await startNodeBackend(options);
	const secondMessages: Array<Record<string, unknown>> = [];
	createInterface({ input: second.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		secondMessages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(secondMessages, "runtime.ready"));
	writeRequest(second, "bootstrap-a", "session.bootstrap", { protocol_version: 1 });
	const restarted = await waitFor(() => response(secondMessages, "bootstrap-a"));
	const restartedStatus = resultValue(restarted, "status") as Record<string, unknown>;
	assert.equal(restartedStatus.model, "gpt-session-a");
	assert.equal(restartedStatus.thinking_effort, "high");
	assert.equal(restartedStatus.collaboration_mode, "plan");
	writeRequest(second, "resume-corrupt", "session.resume", { session_id: "session-corrupt" });
	const corruptResume = await waitFor(() => response(secondMessages, "resume-corrupt"));
	assert.equal(
		"error" in corruptResume
			? (corruptResume.error as Record<string, unknown>).code
			: undefined,
		"session_state_invalid",
	);
	writeRequest(second, "status-after-corrupt", "status.inspect", {});
	const afterCorrupt = await waitFor(() => response(secondMessages, "status-after-corrupt"));
	assert.equal(resultValue(afterCorrupt, "session_id"), "session-a");
	assert.equal(resultValue(afterCorrupt, "model"), "gpt-session-a");
	writeRequest(second, "shutdown-session-preferences-restarted", "shutdown", {});
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

function providerToolNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((tool) => {
		if (typeof tool !== "object" || tool === null) return [];
		if ("name" in tool && typeof tool.name === "string") return [tool.name];
		if ("type" in tool && typeof tool.type === "string" && tool.type !== "function") {
			return [tool.type];
		}
		return [];
	});
}

interface ProviderStepSnapshot {
	readonly providerStep: number;
	readonly providerConfig: unknown;
	readonly boundary?: unknown;
	readonly hasPrevious: boolean;
	readonly commonPrefixItemCount?: unknown;
	readonly timelineEventCount?: unknown;
	readonly orderedItems: readonly unknown[];
	readonly request: unknown;
	readonly lifecycle: readonly string[];
	readonly lifecyclePayloads: readonly unknown[];
}

interface RootAdapterParitySnapshot {
	readonly conversation: readonly unknown[];
	readonly providerBodies: readonly unknown[];
	readonly providerSteps: readonly ProviderStepSnapshot[];
	readonly turn: Readonly<Record<string, unknown>>;
	readonly terminalReport: unknown;
	readonly transcript: readonly unknown[];
	readonly gatewayOrder: readonly string[];
}

function providerStepSnapshots(
	store: RuntimeSessionStore,
	sessionId: string,
): readonly ProviderStepSnapshot[] {
	const manifests = [];
	let manifest = store.modelInputLedger.loadLatestProviderRequestManifest(sessionId);
	while (manifest) {
		manifests.push(manifest);
		manifest = manifest.previousManifestId
			? store.modelInputLedger.loadProviderRequestManifest(manifest.previousManifestId)
			: undefined;
	}
	return manifests.reverse().map((current) => {
		const reconstructed = store.modelInputLedger.reconstructProviderStep(current.requestId);
		const events = store.modelInputLedger.loadProviderStepEvents(current.requestId);
		return {
			providerStep: current.providerStep,
			providerConfig: current.providerConfig,
			...(current.boundary === undefined ? {} : { boundary: current.boundary }),
			hasPrevious: current.previousManifestId !== undefined,
			...(current.schemaVersion === 2 || current.schemaVersion === 3
				? { commonPrefixItemCount: current.commonPrefixItemCount }
				: {}),
			...(current.schemaVersion === 3 ? {
				timelineEventCount: current.timelineEventCount,
			} : {}),
			orderedItems: current.schemaVersion === 3 ? [] : current.orderedItems.map((item) => ({
				kind: item.kind,
				...(item.role ? { role: item.role } : {}),
				...(item.kind === "provider_timeline_event"
					? {}
					: { contentSha256: item.contentSha256 }),
			})),
			request: normalizeProviderRequest(reconstructed.request),
			lifecycle: events.map((event) => event.state),
			lifecyclePayloads: events.map((event) => event.payload),
		};
	});
}

function normalizeProviderRequest(value: object): unknown {
	return normalizeValue(value, new Set([
		"promptCacheKey", "previousResponseId", "sourceId", "supersedesItemId",
	]));
}

function normalizeCanonicalItem(value: unknown): unknown {
	return normalizeValue(value, new Set(["providerState", "responseId"]));
}

function normalizeGatewayParams(value: unknown): unknown {
	return normalizeValue(value, new Set(["duration_ms", "turn_id"]));
}

function normalizeTranscriptItems(value: unknown): readonly unknown[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => normalizeValue(item, new Set([
		"created_at", "duration_ms", "id", "thread_id", "turn_id", "timestamp",
	])));
}

function normalizeValue(value: unknown, omittedKeys: ReadonlySet<string>): unknown {
	if (Array.isArray(value)) return value.map((item) => normalizeValue(item, omittedKeys));
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(Object.entries(value as Readonly<Record<string, unknown>>)
		.filter(([key]) => !omittedKeys.has(key))
		.map(([key, item]) => [key, normalizeValue(item, omittedKeys)]));
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
	store: RuntimeSessionStore,
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
		responseId: "resp-seed",
		completedAt: "2026-08-04T00:00:01.000Z",
	});
}

function seedWaitingApproval(
	store: RuntimeSessionStore,
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
			name: "request_permissions",
			argumentsJson: JSON.stringify({ permissions: { network: { enabled: true } } }),
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
			payload: pendingPermissionDecision(callId) as Extract<RuntimeStateRecord, {
				kind: "pending_decision";
			}>["payload"],
		},
		suspendedTurn: {
			kind: "suspended_turn",
			version: 1,
			payload: {
				...suspendedPermissionApproval(sessionId, callId),
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
			toolName: "request_permissions",
			status: "waiting",
			updatedAt: "2026-08-04T00:00:02.000Z",
		},
	});
}

function pendingPermissionDecision(callId: string): Record<string, unknown> {
	return {
		tool_call: {
			name: "request_permissions",
			arguments: { permissions: { network: { enabled: true } } },
			reason: "Fetch an external dependency.",
			call_id: callId,
		},
		kind: "needs_choice",
		reason: "Fetch an external dependency.",
		preview: "Request network access",
		options: ["approve_once", "reject", "allow_session"],
		command_pattern: null,
		proposed_execpolicy_pattern: null,
		metadata: {
			permission_request: { network: { enabled: true } },
		},
	};
}

function suspendedPermissionApproval(sessionId: string, callId: string): Record<string, unknown> {
	return {
		...suspendedApproval(sessionId, callId),
		pending_approval: {
			tool_call: pendingPermissionDecision(callId).tool_call,
			reason: "Fetch an external dependency.",
			preview: "Request network access",
			command_pattern: null,
			proposed_execpolicy_pattern: null,
			metadata: {},
		},
	};
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
