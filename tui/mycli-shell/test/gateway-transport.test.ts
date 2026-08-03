import assert from "node:assert/strict";
import process from "node:process";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
	closeGatewayTransport,
	configureGatewayTransport,
	gatewayTransport,
} from "../src/adapters/gateway-transport.ts";

test("gateway transport defaults to process protocol streams", () => {
	const transport = gatewayTransport();

	assert.equal(transport.input, process.stdin);
	assert.equal(transport.output, process.stdout);
});

test("gateway transport accepts one sidecar stream pair and closes it once", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	let closeCalls = 0;

	configureGatewayTransport({
		input,
		output,
		close: async () => {
			closeCalls += 1;
		},
	});

	assert.equal(gatewayTransport().input, input);
	assert.equal(gatewayTransport().output, output);
	await closeGatewayTransport();
	await closeGatewayTransport();
	assert.equal(closeCalls, 1);
});

test("gateway transport rejects replacement after configuration", () => {
	assert.throws(
		() =>
			configureGatewayTransport({
				input: new PassThrough(),
				output: new PassThrough(),
			}),
		/Gateway transport is already configured/,
	);
});
