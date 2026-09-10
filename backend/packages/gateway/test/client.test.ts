import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ContractValidationError, GatewayRpcValidationError } from "@mycli/contracts";
import { GatewayClient, GatewayRequestError } from "../src/index.ts";

test("client bounds pending RPCs and keeps interruption capacity without writing rejected mutations", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const methods: string[] = [];
	output.on("data", (chunk) => methods.push((JSON.parse(String(chunk)) as { method: string }).method));
	const client = new GatewayClient({ input, output, limits: { maxPendingRequests: 1 } });
	client.start();
	const pending = client.send("hold");
	await assert.rejects(client.send("turn.submit"), (error: unknown) =>
		error instanceof GatewayRequestError && error.code === "gateway_overloaded" && error.data.dispatched === false);
	const interrupt = client.request("turn.interrupt", { turn_id: "turn" });
	assert.deepEqual(methods, ["hold", "turn.interrupt"]);
	client.stop();
	await assert.rejects(pending, /closed/);
	await assert.rejects(interrupt, /closed/);
});

test("client rejects oversized incomplete frames immediately and preserves split UTF-8 replies", async () => {
	const input = new PassThrough();
	const client = new GatewayClient({ input, output: new PassThrough(), limits: { maxFrameBytes: 128 } });
	client.start();
	const pending = client.send("echo");
	const reply = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: "1", result: { text: "\u4e2d\u6587" } })}\n`);
	for (const byte of reply) input.write(Buffer.from([byte]));
	assert.deepEqual(await pending, { text: "\u4e2d\u6587" });
	const next = client.send("echo");
	input.write(" ".repeat(128));
	input.write("x");
	await assert.rejects(next, { code: "gateway_message_too_large" });
	assert.equal(input.destroyed, true);
	client.stop();
});

test("client rejects queued output on abort and never forwards the unsent suffix", async () => {
	let writes = 0;
	let completeWrite!: () => void;
	const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback): void {
		writes++; completeWrite = callback;
	} });
	const controller = new AbortController();
	const client = new GatewayClient({ input: new PassThrough(), output, signal: controller.signal });
	client.start();
	const first = client.send("first");
	const second = client.send("second");
	controller.abort(new Error("cancelled"));
	await assert.rejects(first, /cancelled/);
	await assert.rejects(second, /cancelled/);
	completeWrite();
	await delay(0);
	assert.equal(writes, 1);
	assert.equal(output.listenerCount("drain"), 0);
	client.stop(); output.destroy();
});

test("request timeout closes the connection with an unknown outcome and cleans event waiters", async () => {
	const input = new PassThrough();
	const client = new GatewayClient({ input, output: new PassThrough(), requestTimeoutMs: 10 });
	client.start();
	const pending = assert.rejects(client.send("hold"), { code: "gateway_request_timeout" });
	const event = assert.rejects(client.waitForEvent("turn.completed"), { code: "gateway_request_timeout" });
	await delay(30);
	await pending; await event;
	assert.equal(input.destroyed, true);
	client.stop();
});

test("replay bytes and event waiters are bounded while live notifications remain observable", async () => {
	const input = new PassThrough();
	const observed: string[] = [];
	const client = new GatewayClient({
		input, output: new PassThrough(), eventReplayBytes: 100, eventWaiterLimit: 1,
		log: (event) => { if (event.method === "message.delta") observed.push(event.params.text); },
	});
	client.start();
	for (const text of ["one", "two", "x".repeat(200)]) {
		input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "message.delta", params: { client_turn_id: "turn", text } })}\n`);
	}
	assert.deepEqual(observed, ["one", "two", "x".repeat(200)]);
	const replayed = await client.waitForEvent("message.delta");
	assert.ok(replayed.method === "message.delta");
	assert.equal(replayed.params.text, "two");
	const missing = assert.rejects(client.waitForEvent("message.delta", () => true, 10), /Timed out/);
	await assert.rejects(client.waitForEvent("runtime.ready"), { code: "gateway_overloaded" });
	await missing;
	client.stop();
});

test("shared client correlates out-of-order replies and validates their method results", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const client = new GatewayClient({ input, output });
	client.start();
	client.start();
	const first = client.request("shutdown", {});
	const second = client.request("model.list", { provider: "test" });
	input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "2", result: { provider: "test", models: [] } })}\n`);
	input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "1", result: { ok: true } })}\n`);
	assert.deepEqual(await first, { ok: true });
	assert.deepEqual(await second, { provider: "test", models: [] });
	client.stop();
	assert.equal(input.listenerCount("error"), 0);
	assert.equal(output.listenerCount("error"), 0);
});

test("invalid results reject pending requests and event waiters before consumption", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	let closures = 0;
	const client = new GatewayClient({ input, output, onClose: () => { closures++; } });
	client.start();
	const pending = client.request("model.list", { provider: "test" });
	const waiting = client.waitForEvent("turn.completed");
	input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "1", result: { provider: "test", models: "wrong" } })}\n`);
	await assert.rejects(pending, GatewayRpcValidationError);
	await assert.rejects(waiting, GatewayRpcValidationError);
	await assert.rejects(client.waitForEvent("runtime.ready"), /closed/);
	assert.equal(closures, 1);
	client.stop();
});

test("abort clears requests and event timers and preserves the cancellation reason", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const controller = new AbortController();
	const client = new GatewayClient({ input, output, signal: controller.signal });
	client.start();
	const pending = client.request("shutdown", {});
	const event = client.waitForEvent("runtime.ready");
	const reason = new Error("cancelled by owner");
	controller.abort(reason);
	await assert.rejects(pending, reason);
	await assert.rejects(event, reason);
	assert.equal(input.listenerCount("error"), 0);
	assert.equal(output.listenerCount("error"), 0);
	client.stop();
});

test("typed requests reject invalid mutations before writing to transport", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const client = new GatewayClient({ input, output });
	client.start();
	// @ts-expect-error Invalid permission names must fail both compile-time and runtime checks.
	await assert.rejects(client.request("permissions.update", { profile: "admin" }), GatewayRpcValidationError);
	// @ts-expect-error A queue restoration acknowledgement always requires its token.
	await assert.rejects(client.request("turn.queue.restore.ack", {}), GatewayRpcValidationError);
	// @ts-expect-error Settings mutations require a settings object or a setting id and value.
	await assert.rejects(client.request("settings.save", {}), GatewayRpcValidationError);
	assert.equal(output.readableLength, 0);
	client.stop();
});

test("a server request cannot fulfill a client request with the same id", async () => {
	const input = new PassThrough();
	const client = new GatewayClient({ input, output: new PassThrough() });
	client.start();
	let resolved = false;
	const pending = client.request("shutdown", {}).then((result) => { resolved = true; return result; });
	input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "1", method: "shutdown", params: {} })}\n`);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(resolved, false);
	input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "1", result: { ok: true } })}\n`);
	assert.deepEqual(await pending, { ok: true });
	client.stop();
});

test("malformed typed history and mirrored tool records never reach client consumers", async () => {
	for (const mirrored of [false, true]) {
		const input = new PassThrough();
		let delivered = 0;
		const client = new GatewayClient({ input, output: new PassThrough(), log: () => { delivered++; } });
		client.start();
		const pending = client.request("transcript.load", { session_id: "session" });
		const tool_record = { version: 1, kind: "tool_execution", name: "Read", status: "success", mutating: false, arguments: { private: "value" } };
		const message = mirrored
			? { jsonrpc: "2.0", method: "runtime.event", params: { version: 1, sequence: 1, timestamp: 0,
				type: "tool.complete", payload: { name: "Read", tool_record },
			} }
			: { jsonrpc: "2.0", id: "1", result: { session_id: "session", next_before: null,
				items: [{ id: "tool", type: "tool_summary", text: "Read", folded: false, metadata: {}, tool_record }],
			} };
		input.write(`${JSON.stringify(message)}\n`);
		await assert.rejects(pending, ContractValidationError);
		assert.equal(delivered, 0);
		client.stop();
	}
});
