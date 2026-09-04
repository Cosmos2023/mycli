import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { NodeGatewayRpcTransport } from "../src/node-runtime/node-gateway-rpc-transport.ts";

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
