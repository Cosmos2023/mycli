import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mock } from "node:test";
import { closeGatewayTransport, configureGatewayTransport } from "../../src/transport/gateway-transport.ts";
import { TtyOpenError } from "../../src/platform/tty-terminal.ts";
import { HeadlessTerminal } from "../support/headless-terminal.ts";

// The entry claims the terminal before it waits for the gateway, so the fixture
// substitutes a headless terminal and then fails the transport underneath it.
const terminal = new HeadlessTerminal({ rows: 24, columns: 100 });
mock.module(new URL("../../src/platform/tty-terminal.ts", import.meta.url).href, {
	namedExports: {
		TtyOpenError,
		openTtyStreams: () => ({ close: (): void => {} }),
		StreamTerminal: function (): HeadlessTerminal { return terminal; },
	},
});

const exitCode = process.exitCode;
const sigintListeners = process.listenerCount("SIGINT");
const sigtermListeners = process.listenerCount("SIGTERM");
const input = new PassThrough();
const output = new PassThrough();
let closeCalls = 0;
configureGatewayTransport({ input, output, close: () => {
	closeCalls += 1;
	input.destroy();
	output.destroy();
} });

const gateway = await import("../../src/gateway.ts");
try {
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
	await gateway.gatewayShutdown();
	await closeGatewayTransport();
	input.destroy();
	output.destroy();
	process.exitCode = exitCode;
}

console.log("gateway-entry-failure: passed");
