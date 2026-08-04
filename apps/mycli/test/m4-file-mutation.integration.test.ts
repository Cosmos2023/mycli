import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { parseJsonRpcMessage } from "@mycli/contracts";
import { SQLiteSessionStore } from "@mycli/storage";
import { startNodeBackend, type NodeBackend } from "../src/node-runtime/node-backend.ts";

type Protocol = "responses" | "chat_completions";
type JsonObject = Record<string, unknown>;

test("Responses reads then edits a file with durable mutation metadata", async (t) => {
	const fixture = await scenarioFixture(t, "responses", [
		responsesTool("call-read", "Read", { file_path: "README.md", offset: 1, limit: 20 }),
		responsesTool("call-edit", "Edit", {
			file_path: "README.md",
			old_string: "beta",
			new_string: "gamma",
		}),
		responsesFinal("Mutation completed."),
	]);
	await writeFile(join(fixture.workspace, "README.md"), "alpha\nbeta\n", "utf8");

	await submitAndWait(fixture, "Read README.md, replace beta with gamma, then finish.");
	assert.deepEqual(toolNames(fixture.requestBodies[0]?.tools, "responses"), [
		"Read", "Edit", "Patch", "Write",
	]);
	assert.equal(await readFile(join(fixture.workspace, "README.md"), "utf8"), "alpha\ngamma\n");
	assert.equal(existsSync(fixture.pythonMarker), false);
	assert.equal(events(fixture.messages, "tool.start").length, 2);
	assert.equal(events(fixture.messages, "tool.complete").length, 2);
	assert.equal(events(fixture.messages, "tool.failed").length, 0);

	await fixture.shutdown();
	assert.deepEqual(conversationTypes(fixture.dbPath, fixture.sessionId), [
		"user",
		"assistant_tool_calls",
		"tool_result",
		"assistant_tool_calls",
		"tool_result",
		"assistant",
	]);
});

test("Responses recovers from Edit before Read in the same turn", async (t) => {
	const fixture = await scenarioFixture(t, "responses", [
		responsesTool("call-edit-missing", "Edit", {
			file_path: "README.md",
			old_string: "beta",
			new_string: "gamma",
		}),
		responsesTool("call-read", "Read", { file_path: "README.md", offset: 1, limit: 20 }),
		responsesTool("call-edit", "Edit", {
			file_path: "README.md",
			old_string: "beta",
			new_string: "gamma",
		}),
		responsesFinal("Recovered and completed."),
	]);
	await writeFile(join(fixture.workspace, "README.md"), "alpha\nbeta\n", "utf8");

	await submitAndWait(fixture, "Replace beta with gamma and recover from tool errors.");
	assert.equal(await readFile(join(fixture.workspace, "README.md"), "utf8"), "alpha\ngamma\n");
	assert.equal(events(fixture.messages, "tool.start").length, 3);
	assert.equal(events(fixture.messages, "tool.complete").length, 2);
	assert.equal(events(fixture.messages, "tool.failed").length, 1);
	assert.equal(JSON.stringify(fixture.requestBodies[1]?.input).includes("missing_read_snapshot"), true);
	assert.equal(existsSync(fixture.pythonMarker), false);

	await fixture.shutdown();
	assert.deepEqual(conversationTypes(fixture.dbPath, fixture.sessionId), [
		"user",
		"assistant_tool_calls", "tool_result",
		"assistant_tool_calls", "tool_result",
		"assistant_tool_calls", "tool_result",
		"assistant",
	]);
});

test("Chat writes a file and replays the matching tool call id", async (t) => {
	const fixture = await scenarioFixture(t, "chat_completions", [
		chatTool("call-write", "Write", {
			file_path: "created.txt",
			content: "created by node\n",
		}),
		chatFinal("File created."),
	]);

	await submitAndWait(fixture, "Create created.txt with the requested content.");
	assert.deepEqual(toolNames(fixture.requestBodies[0]?.tools, "chat_completions"), [
		"Read", "Edit", "Patch", "Write",
	]);
	assert.equal(await readFile(join(fixture.workspace, "created.txt"), "utf8"), "created by node\n");
	const continuation = fixture.requestBodies[1]?.messages;
	assert.equal(JSON.stringify(continuation).includes('"id":"call-write"'), true);
	assert.equal(JSON.stringify(continuation).includes('"tool_call_id":"call-write"'), true);
	assert.equal(events(fixture.messages, "tool.complete").length, 1);
	assert.equal(events(fixture.messages, "tool.failed").length, 0);
	assert.equal(existsSync(fixture.pythonMarker), false);

	await fixture.shutdown();
	assert.deepEqual(conversationTypes(fixture.dbPath, fixture.sessionId), [
		"user", "assistant_tool_calls", "tool_result", "assistant",
	]);
});

interface ScenarioFixture {
	readonly backend: NodeBackend;
	readonly dbPath: string;
	readonly messages: JsonObject[];
	readonly protocol: Protocol;
	readonly pythonMarker: string;
	readonly requestBodies: JsonObject[];
	readonly sessionId: string;
	readonly workspace: string;
	readonly shutdown: () => Promise<void>;
}

async function scenarioFixture(
	t: test.TestContext,
	protocol: Protocol,
	steps: readonly (readonly JsonObject[])[],
): Promise<ScenarioFixture> {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-m4-mutation-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	const pythonMarker = join(root, "python-started");
	const sessionId = `m4-${protocol}`;
	await mkdir(home);
	await mkdir(workspace);
	const requestBodies: JsonObject[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => {
			requestBodies.push(JSON.parse(body) as JsonObject);
			writeSse(response, steps[requestBodies.length - 1] ?? []);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", sessionId, "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: protocol,
			MYCLI_PYTHON: pythonMarker,
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_REQUEST_MAX_RETRIES: "0",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	const messages: JsonObject[] = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as JsonObject);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	let closed = false;
	const shutdown = async () => {
		if (closed) return;
		closed = true;
		writeRequest(backend, "shutdown", "shutdown", {});
		assert.equal(await backend.completion, 0);
	};
	t.after(async () => {
		await shutdown();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve());
		});
		await rm(root, { recursive: true, force: true });
	});
	return {
		backend,
		dbPath: join(home, ".mycli", "sessions.db"),
		messages,
		protocol,
		pythonMarker,
		requestBodies,
		sessionId,
		workspace,
		shutdown,
	};
}

async function submitAndWait(fixture: ScenarioFixture, message: string): Promise<void> {
	writeRequest(fixture.backend, "turn", "turn.submit", {
		message,
		client_turn_id: `${fixture.sessionId}-turn`,
		client_user_message_id: `${fixture.sessionId}-message`,
	});
	await waitFor(() => fixture.messages.find((item) => {
		if (item.method !== "message.complete") return false;
		const params = item.params as JsonObject | undefined;
		return params?.final === true;
	}));
}

function responsesTool(callId: string, name: string, argumentsValue: JsonObject): readonly JsonObject[] {
	return [
		{
			type: "response.output_item.done",
			item: { type: "function_call", call_id: callId, name, arguments: JSON.stringify(argumentsValue) },
		},
		{ type: "response.completed", response: { id: `resp-${callId}` } },
	];
}

function responsesFinal(text: string): readonly JsonObject[] {
	return [
		{ type: "response.output_text.delta", delta: text },
		{ type: "response.completed", response: { id: "resp-final" } },
	];
}

function chatTool(callId: string, name: string, argumentsValue: JsonObject): readonly JsonObject[] {
	return [{
		id: `chat-${callId}`,
		choices: [{
			index: 0,
			delta: { tool_calls: [{
				index: 0,
				id: callId,
				type: "function",
				function: { name, arguments: JSON.stringify(argumentsValue) },
			}] },
			finish_reason: "tool_calls",
		}],
	}];
}

function chatFinal(text: string): readonly JsonObject[] {
	return [{
		id: "chat-final",
		choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
	}];
}

function writeSse(response: ServerResponse, items: readonly JsonObject[]): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	for (const item of items) response.write(`data: ${JSON.stringify(item)}\n\n`);
	response.end("data: [DONE]\n\n");
}

function toolNames(value: unknown, protocol: Protocol): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (typeof entry !== "object" || entry === null) return [];
		if (protocol === "responses" && "name" in entry && typeof entry.name === "string") {
			return [entry.name];
		}
		if (!("function" in entry) || typeof entry.function !== "object" || entry.function === null) return [];
		return "name" in entry.function && typeof entry.function.name === "string"
			? [entry.function.name]
			: [];
	});
}

function conversationTypes(dbPath: string, sessionId: string): string[] {
	const store = new SQLiteSessionStore({ dbPath });
	try {
		return store.loadConversationItems(sessionId).map((item) => item.type);
	} finally {
		store.close();
	}
}

function writeRequest(
	backend: NodeBackend,
	id: string,
	method: string,
	params: JsonObject,
): void {
	backend.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function event(messages: JsonObject[], method: string): JsonObject | undefined {
	return messages.find((message) => message.method === method && !("id" in message));
}

function events(messages: JsonObject[], method: string): JsonObject[] {
	return messages.filter((message) => message.method === method && !("id" in message));
}

async function waitFor<T>(read: () => T | undefined | false, timeoutMs = 3_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("timed out waiting for Node M4 mutation turn");
}
