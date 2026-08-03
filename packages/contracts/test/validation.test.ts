import assert from "node:assert/strict";
import test from "node:test";
import {
	ContractValidationError,
	parseGatewayEvent,
	parseJsonRpcMessage,
} from "../src/index.ts";

test("validates a typed gateway notification", () => {
	const event = parseGatewayEvent({
		jsonrpc: "2.0",
		method: "turn.started",
		params: { client_turn_id: "client-1", turn_id: "turn-1" },
	});
	assert.equal(event.method, "turn.started");
});

test("rejects a gateway notification missing required payload fields", () => {
	assert.throws(
		() => parseGatewayEvent({ jsonrpc: "2.0", method: "turn.started", params: {} }),
		ContractValidationError,
	);
});

test("rejects malformed JSON-RPC envelopes", () => {
	assert.throws(
		() => parseJsonRpcMessage({ jsonrpc: "1.0", method: "turn.started", params: {} }),
		ContractValidationError,
	);
});
