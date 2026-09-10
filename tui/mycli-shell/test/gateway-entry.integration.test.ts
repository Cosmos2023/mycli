import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { closeGatewayTransport, configureGatewayTransport } from "../src/transport/gateway-transport.ts";

test("public gateway entry exposes startup failure and closes its configured transport", { timeout: 5_000 }, async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const exitCode = process.exitCode;
	const sigintListeners = process.listenerCount("SIGINT");
	const sigtermListeners = process.listenerCount("SIGTERM");
	let closeCalls = 0;
	configureGatewayTransport({ input, output, close: () => {
		closeCalls += 1;
		input.destroy();
		output.destroy();
	} });
	let gateway: typeof import("../src/gateway.ts") | undefined;
	try {
		gateway = await import("../src/gateway.ts");
		assert.ok(gateway.gatewayStartup instanceof Promise);
		assert.equal(typeof gateway.gatewayShutdown, "function");
		const startupFailure = assert.rejects(gateway.gatewayStartup, /fixture_transport_closed/);
		input.destroy(new Error("fixture_transport_closed"));
		await startupFailure;
		await gateway.gatewayShutdown();
		assert.equal(closeCalls, 1);
		assert.equal(process.listenerCount("SIGINT"), sigintListeners);
		assert.equal(process.listenerCount("SIGTERM"), sigtermListeners);
	} finally {
		await gateway?.gatewayShutdown();
		await closeGatewayTransport();
		input.destroy();
		output.destroy();
		process.exitCode = exitCode;
	}
});
