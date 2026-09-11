import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WorkspaceTrustStore } from "@mycli/config";
import { GatewayClient, type GatewayEvent } from "@mycli/gateway";
import { startSupervisedNodeBackend } from "../src/node-runtime/node-backend-supervisor.ts";
import type { NodeBackend } from "../src/node-runtime/node-backend.ts";

test("supervised gateway survives bursty reasoning and text after an interrupted turn", { timeout: 30_000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-gateway-streaming-"));
	const homeDir = join(root, "home");
	const workspace = join(root, "workspace");
	const reasoning = Array.from({ length: 790 }, (_, index) => `reason-${index}:\u4e2d\u6587\uD83D\uDE00\n`);
	const answer = Array.from({ length: 790 }, (_, index) => `text-${index}:\u4e2d\u6587\uD83D\uDE00\n`);
	const responses = new Set<ServerResponse>();
	let requests = 0;
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			responses.add(response);
			response.once("close", () => responses.delete(response));
			response.writeHead(200, { "content-type": "text/event-stream" });
			const current = ++requests;
			if (current === 2) {
				const interval = setInterval(() => writeDelta(response, { reasoning_content: "pending" }), 10);
				response.once("close", () => clearInterval(interval));
				return;
			}
			if (current === 1) writeDelta(response, { role: "assistant", content: "ready" });
			else {
				for (const text of reasoning) writeDelta(response, { reasoning_content: text });
				for (const text of answer) writeDelta(response, { content: text });
			}
			writeDelta(response, {}, "stop");
			response.end("data: [DONE]\n\n");
		});
	});
	const resources: { backend?: NodeBackend; client?: GatewayClient } = {};
	t.after(async () => {
		resources.client?.stop();
		await resources.backend?.close();
		for (const response of responses) response.destroy();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	});
	await mkdir(join(homeDir, ".mycli"), { recursive: true });
	await mkdir(workspace);
	await writeFile(join(homeDir, ".mycli", "config.toml"), "[updates]\ncheck_on_startup = false\n");
	await new WorkspaceTrustStore({ homeDir }).save(workspace, "trusted");
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const backend = await startSupervisedNodeBackend({
		cwd: workspace, args: ["--session", "streaming-regression"],
		env: {
			PATH: process.env.PATH, HOME: homeDir, USERPROFILE: homeDir,
			MYCLI_API_KEY: "fixture-key", MYCLI_PROVIDER: "deepseek", MYCLI_MODEL: "deepseek-v4-flash",
			MYCLI_PROTOCOL: "chat_completions", MYCLI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
			MYCLI_THINKING_EFFORT: "high", MYCLI_REQUEST_MAX_RETRIES: "0", MYCLI_STREAM_MAX_RETRIES: "0",
			MYCLI_MAX_PROMPT_TOKENS: "128000", MYCLI_MEMORY_ENABLED: "false", MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
		},
	});
	resources.backend = backend;
	const events: GatewayEvent[] = [];
	const closures: Error[] = [];
	const client = new GatewayClient({ ...backend.transport, log: (event) => events.push(event), onClose: (error) => closures.push(error) });
	resources.client = client;
	client.start();
	await client.waitForEvent("runtime.ready");
	const submit = async (id: string): Promise<void> => {
		const result = await client.request("turn.submit", { message: id, client_turn_id: id, client_user_message_id: `message-${id}` });
		assert.equal(result.accepted, true);
	};
	await submit("first");
	await client.waitForEvent("turn.completed", (event) => event.method === "turn.completed" && event.params.client_turn_id === "first");
	await submit("interrupted");
	const started = await client.waitForEvent("turn.started", (event) => event.method === "turn.started" && event.params.client_turn_id === "interrupted");
	assert.ok(started.method === "turn.started");
	await client.waitForEvent("reasoning.delta", (event) => event.method === "reasoning.delta" && event.params.client_turn_id === "interrupted");
	await client.request("turn.interrupt", { turn_id: String(started.params.turn_id) });
	await client.waitForEvent("turn.interrupted", (event) => event.method === "turn.interrupted" && event.params.client_turn_id === "interrupted" && event.params.requested !== true);
	await submit("burst");
	const terminal = await client.waitForEvent("turn.completed", (event) => event.method === "turn.completed" && event.params.client_turn_id === "burst");
	assert.ok(terminal.method === "turn.completed");
	assert.equal(terminal.params.assistant_message, answer.join(""));
	for (const method of ["reasoning.delta", "thinking.delta", "message.delta"] as const) {
		const text = events.flatMap((event) => event.method === method && event.params.client_turn_id === "burst" ? [event.params.text] : []).join("");
		assert.equal(text, (method === "message.delta" ? answer : reasoning).join(""), method);
	}
	assert.equal(requests, 3);
	assert.deepEqual(closures, []);
	assert.equal(events.some((event) => event.method === "turn.failed"), false);
	client.expectClose();
	await client.request("shutdown", {});
	assert.equal(await backend.completion, 0);
	await backend.close();
	assert.equal(backend.diagnostic(), "");
	const db = new DatabaseSync(join(homeDir, ".mycli", "sessions.db"), { readOnly: true });
	try {
		const turns = db.prepare("SELECT client_turn_id, status FROM runtime_turns WHERE session_id = ? ORDER BY started_at").all("streaming-regression");
		assert.deepEqual(turns.map((turn) => [turn.client_turn_id, turn.status]), [["first", "completed"], ["interrupted", "interrupted"], ["burst", "completed"]]);
	} finally { db.close(); }
	const trace = await readFile(join(homeDir, ".mycli", "traces", "streaming-regression-trace.jsonl"), "utf8");
	const rows = trace.trim().split("\n").map((line) => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });
	assert.equal(rows.filter((row) => row.kind === "turn_interrupt_requested").length, 1);
	assert.equal(rows.filter((row) => row.kind === "turn_interrupted").length, 1);
	const diagnostics = rows.filter((row) => row.kind === "model_stream_diagnostics").at(-1)!;
	assert.equal(diagnostics.payload.success, true);
	assert.equal(diagnostics.payload.reasoning_event_count, 790);
	assert.equal(diagnostics.payload.text_event_count, 790);
});

function writeDelta(response: ServerResponse, delta: Readonly<Record<string, string>>, finishReason: string | null = null): void {
	response.write(`data: ${JSON.stringify({ id: "chat-fixture", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}
