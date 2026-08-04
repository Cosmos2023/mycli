import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { parseJsonRpcMessage } from "@mycli/contracts";
import { startNodeBackend } from "../src/node-runtime/node-backend.ts";

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
		},
	});
	const messages: Array<Record<string, unknown>> = [];
	createInterface({ input: backend.transport.input, crlfDelay: Infinity }).on("line", (line) => {
		messages.push(parseJsonRpcMessage(JSON.parse(line)) as Record<string, unknown>);
	});
	await waitFor(() => event(messages, "runtime.ready"));
	writeRequest(backend, "1", "turn.submit", {
		message: "hello",
		client_turn_id: "integration-turn",
		client_user_message_id: "integration-message",
	});
	const final = await waitFor(() => messages.find((message) => {
		if (message.method !== "message.complete") return false;
		const params = message.params as Record<string, unknown> | undefined;
		return params?.final === true;
	}));
	assert.equal((final.params as Record<string, unknown>).text, "hello from node");
	assert.equal(requests, 1);
	assert.equal(capture.requestBody?.model, "gpt-test");
	assert.equal(capture.requestBody?.stream, true);
	assert.deepEqual(
		(capture.requestBody?.tools as Array<Record<string, unknown>> | undefined)
			?.map((tool) => tool.name),
		["Read", "Edit", "Patch", "Write"],
	);
	assert.equal(existsSync(join(home, ".mycli", "sessions.db")), true);
	await waitFor(() => event(messages, "status.changed"));
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

	writeRequest(backend, "2", "shutdown", {});
	assert.equal(await backend.completion, 0);
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

async function waitFor<T>(read: () => T | undefined | false, timeoutMs = 3_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = read();
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("timed out waiting for Node backend");
}
