import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { parseJsonRpcMessage } from "@mycli/contracts";
import { SQLiteSessionStore } from "@mycli/storage";
import { startNodeBackend } from "../src/node-runtime/node-backend.ts";

test("completes and persists a Node-only Responses Read turn", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-m3-read-"));
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	const pythonMarker = join(root, "python-started");
	await mkdir(home);
	await mkdir(workspace);
	await writeFile(join(workspace, "README.md"), "alpha\nbeta\n", "utf8");

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
						call_id: "call-read-1",
						name: "Read",
						arguments: JSON.stringify({ file_path: "README.md", offset: 1, limit: 2 }),
					},
				})}\n\n`);
				response.write("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-tools\"}}\n\n");
			} else {
				response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"README inspected.\"}\n\n");
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

	const backend = await startNodeBackend({
		cwd: workspace,
		args: ["--session", "m3-integration", "--model", "gpt-test"],
		env: {
			HOME: home,
			MYCLI_API_KEY: "test-key",
			MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_PROVIDER: "openai",
			MYCLI_PROTOCOL: "responses",
			MYCLI_PYTHON: pythonMarker,
			MYCLI_THINKING_ENABLED: "false",
			MYCLI_STREAM_MAX_RETRIES: "0",
		},
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	writeRequest(backend, "1", "turn.submit", {
		message: "Read README.md and report briefly.",
		client_turn_id: "m3-client-turn",
		client_user_message_id: "m3-user-message",
	});
	const final = await waitFor(() => messages.find((message) => {
		if (message.method !== "message.complete") return false;
		const params = message.params as Record<string, unknown> | undefined;
		return params?.final === true;
	}));
	assert.equal((final.params as Record<string, unknown>).text, "README inspected.");
	assert.equal(requestBodies.length, 2);
	assert.deepEqual(toolNames(requestBodies[0]?.tools), ["Read", "Edit", "Patch", "Write"]);
	assert.equal("previous_response_id" in (requestBodies[1] ?? {}), false);
	const continuation = JSON.stringify(requestBodies[1]?.input);
	assert.equal(continuation.includes("function_call"), true);
	assert.equal(continuation.includes("function_call_output"), true);
	assert.equal(continuation.includes("alpha"), true);
	assert.equal(existsSync(pythonMarker), false, "Node Read turn must not start Python");
	assert.ok(event(messages, "tool.start"));
	assert.ok(event(messages, "tool.complete"));
	assert.equal(event(messages, "tool.failed"), undefined);
	assert.equal(JSON.stringify(messages.filter((message) => message.method?.toString().startsWith("tool."))).includes("alpha"), false);

	writeRequest(backend, "2", "shutdown", {});
	assert.equal(await backend.completion, 0);
	const dbPath = join(home, ".mycli", "sessions.db");
	const store = new SQLiteSessionStore({ dbPath });
	try {
		assert.deepEqual(store.loadConversationItems("m3-integration").map((item) => item.type), [
			"user",
			"assistant_tool_calls",
			"tool_result",
			"assistant",
		]);
	} finally {
		store.close();
	}
});

function toolNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((tool) => {
		if (typeof tool !== "object" || tool === null || !("name" in tool)) return [];
		return typeof tool.name === "string" ? [tool.name] : [];
	});
}

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

async function waitFor<T>(read: () => T | undefined | false, timeoutMs = 3_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("timed out waiting for Node M3 Read turn");
}
