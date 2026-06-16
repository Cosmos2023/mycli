import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { GatewayClient, GatewayRequestError } from "../src/adapters/gateway-client.ts";

test("gateway client rejects pending requests when output pipe closes", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const client = new GatewayClient({ input, output });

	client.start();
	const pending = client.send("session.bootstrap", {});
	output.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));

	await assert.rejects(pending, /write EPIPE/);
	await assert.rejects(
		client.send("status.inspect", {}),
		(error) =>
			error instanceof GatewayRequestError &&
			error.code === "pipe_closed" &&
			error.method === "status.inspect",
	);
	client.stop();
});

test("gateway client ignores input after closure", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const events: string[] = [];
	const client = new GatewayClient({
		input,
		output,
		log: (event) => events.push(event.method),
	});

	client.start();
	output.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
	input.write('{"jsonrpc":"2.0","method":"status.changed","params":{}}\n');
	await setTimeout(10);

	assert.deepEqual(events, []);
	client.stop();
});
