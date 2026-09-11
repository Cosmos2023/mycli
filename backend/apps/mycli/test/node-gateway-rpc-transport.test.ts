import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { GatewayRpcValidationError } from "@mycli/contracts";
import { NodeGatewayRpcTransport } from "../src/node-runtime/node-gateway-rpc-transport.ts";

test("RPC admission rejects overload before dispatch and reserves shutdown capacity", async () => {
	const dispatched: string[] = [];
	let finish!: (value: Record<string, unknown>) => void;
	const rpc = new NodeGatewayRpcTransport({
		limits: { maxPendingRequests: 1 },
		dispatch: (request) => {
			dispatched.push(request.method);
			return request.method === "shutdown" ? { ok: true } : new Promise((resolve) => { finish = resolve; });
		},
		mapFailure: () => ({ code: "internal_error", message: "failed" }), close: () => {},
	});
	const rows: Record<string, unknown>[] = [];
	rpc.transport.input.on("data", (chunk) => rows.push(JSON.parse(String(chunk))));
	for (const [id, method] of [[1, "hold"], [2, "mutate"], [3, "shutdown"]]) {
		rpc.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: {} })}\n`);
	}
	assert.deepEqual(dispatched, ["hold", "shutdown"]);
	assert.deepEqual(rows[0], {
		jsonrpc: "2.0", id: 2,
		error: { code: "gateway_overloaded", message: "Gateway capacity exceeded.", data: { dispatched: false } },
	});
	finish({ ok: true });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(rows.map((row) => row.id), [2, 3, 1]);
	assert.equal(await rpc.close(), true);
});

test("RPC framing contains oversized fragments without dispatching a following mutation", async () => {
	let dispatched = 0;
	let closures = 0;
	const rpc = new NodeGatewayRpcTransport({
		limits: { maxFrameBytes: 128 }, dispatch: () => { dispatched++; return {}; },
		mapFailure: () => ({ code: "invalid_params", message: "invalid" }), close: () => { closures++; },
	});
	rpc.transport.output.write(" ".repeat(128));
	rpc.transport.output.write(`x\n${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "mutate", params: {} })}\n`);
	assert.equal(dispatched, 0);
	assert.equal(closures, 1);
	assert.equal(rpc.diagnostic(), "gateway_message_too_large");
	assert.equal(await rpc.close(), false);
});

test("RPC output overload closes once instead of silently dropping live notifications", async () => {
	let closures = 0;
	const rpc = new NodeGatewayRpcTransport({
		limits: { maxQueuedMessages: 1 }, dispatch: () => ({}),
		mapFailure: () => ({ code: "internal_error", message: "failed" }), close: () => { closures++; },
	});
	const notification = { jsonrpc: "2.0" as const, method: "message.delta" as const, params: { client_turn_id: "turn", text: "x".repeat(128 * 1024) } };
	rpc.writeNotification(notification);
	rpc.writeNotification(notification);
	rpc.writeNotification(notification);
	assert.equal(closures, 1);
	assert.equal(await rpc.close(), false);
	assert.equal(rpc.diagnostic(), "gateway_overloaded");
	assert.equal(rpc.transport.diagnostic?.(), "gateway_overloaded");
	rpc.dispose();
	assert.equal(rpc.diagnostic(), "gateway_overloaded");
});

test("RPC close drains notifications before ending a slow consumer", async () => {
	const rpc = new NodeGatewayRpcTransport({
		dispatch: () => ({}), mapFailure: () => ({ code: "internal_error", message: "failed" }), close: () => {},
	});
	rpc.writeNotification({ jsonrpc: "2.0", method: "message.delta", params: { client_turn_id: "turn", text: "x".repeat(128 * 1024) } });
	rpc.writeNotification({ jsonrpc: "2.0", method: "turn.completed", params: {
		client_turn_id: "turn", turn_id: "turn", assistant_message: "done", activity_events: [],
		progress_updates: [], plan_steps: [], pending_decision: false, turn_state: "completed",
		usage: { input_tokens: 0, output_tokens: 0 },
	} });
	let closed = false;
	const closing = rpc.close().then((drained) => { closed = true; return drained; });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(closed, false);
	const methods: string[] = [];
	rpc.transport.input.on("data", (chunk) => methods.push((JSON.parse(String(chunk)) as { method: string }).method));
	assert.equal(await closing, true);
	assert.deepEqual(methods, ["message.delta", "turn.completed"]);
});

test("RPC method validation precedes dispatch and rejects malformed successful responses", async () => {
	const dispatched: string[] = [];
	const rpc = new NodeGatewayRpcTransport({
		dispatch: (request) => { dispatched.push(request.method); return Promise.resolve({ models: "bad" }); },
		mapFailure: (_request, error) => ({
			code: error instanceof GatewayRpcValidationError ? error.code : "internal_error",
			message: "Invalid gateway payload.",
		}),
		close: () => {},
	});
	const rows: Record<string, unknown>[] = [];
	rpc.transport.input.on("data", (chunk) => rows.push(JSON.parse(String(chunk))));
	rpc.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "turn.submit", params: { message: "private", client_turn_id: 3 } })}\n`);
	rpc.transport.output.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "model.list", params: { provider: "test" } })}\n`);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(dispatched, ["model.list"]);
	assert.deepEqual(rows.map((row) => row.error), [
		{ code: "invalid_params", message: "Invalid gateway payload." },
		{ code: "internal_error", message: "Invalid gateway payload." },
	]);
	assert.ok(rows.every((row) => !("result" in row)));
	assert.doesNotMatch(JSON.stringify(rows), /private/);
	rpc.close();
});

test("RPC transport parses requests and writes asynchronous results", async () => {
	const rpc = new NodeGatewayRpcTransport({
		dispatch: async (request) => ({ method: request.method, params: request.params }),
		mapFailure: () => ({ code: "internal_error", message: "failed" }),
		close: () => {},
	});

	rpc.transport.output.write(`${JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "status.get",
		params: { verbose: true },
	})}\n`);
	const [chunk] = await once(rpc.transport.input, "data");

	assert.deepEqual(JSON.parse(String(chunk)), {
		jsonrpc: "2.0",
		id: 1,
		result: { method: "status.get", params: { verbose: true } },
	});
	rpc.close();
});

test("RPC transport maps invalid input and request failures at the transport boundary", async () => {
	const failures: string[] = [];
	const rpc = new NodeGatewayRpcTransport({
		dispatch: () => { throw new Error("boom"); },
		mapFailure: (request) => request
			? { code: "request_failed", message: "Request failed.", data: { safe: true } }
			: { code: "invalid_params", message: "Invalid JSON-RPC request." },
		onRequestFailed: (request) => { failures.push(request.method); },
		close: () => {},
	});
	const chunks: string[] = [];
	rpc.transport.input.on("data", (chunk) => { chunks.push(String(chunk)); });

	rpc.transport.output.write("not-json\n");
	rpc.transport.output.write(`${JSON.stringify({
		jsonrpc: "2.0",
		id: 2,
		method: "explode",
		params: {},
	})}\n`);
	await new Promise<void>((resolve) => { setImmediate(resolve); });

	assert.deepEqual(chunks.flatMap((chunk) => chunk.trim().split("\n")).map((line) => JSON.parse(line)), [
		{
			jsonrpc: "2.0",
			id: null,
			error: { code: "invalid_params", message: "Invalid JSON-RPC request." },
		},
		{
			jsonrpc: "2.0",
			id: 2,
			error: {
				code: "request_failed",
				message: "Request failed.",
				data: { safe: true },
			},
		},
	]);
	assert.deepEqual(failures, ["explode"]);
	rpc.close();
});
