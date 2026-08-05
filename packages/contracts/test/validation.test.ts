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

test("validates the complete shell lifecycle gateway surface", () => {
	const common = {
		shell_id: "shell-1",
		session_id: "session-1",
		sequence: 1,
		command_preview: "npm test",
		background: true,
		process_state: "running_background",
	};
	const events = [
		{ method: "shell.started", params: common },
		{
			method: "shell.output",
			params: { ...common, sequence: 2, output_delta: "ready\n", next_cursor: 6 },
		},
		{
			method: "shell.completed",
			params: { ...common, sequence: 3, process_state: "completed", terminal_state: "completed" },
		},
		{ method: "shell.removed", params: { ...common, sequence: 4 } },
		{
			method: "shell.list.updated",
			params: { ...common, sequence: 5, active_background_count: 0 },
		},
	] as const;

	for (const event of events) {
		assert.equal(parseGatewayEvent({ jsonrpc: "2.0", ...event }).method, event.method);
	}
});

test("rejects incomplete shell output and completion events", () => {
	const common = {
		shell_id: "shell-1",
		session_id: "session-1",
		sequence: 1,
		command_preview: "npm test",
		background: false,
		process_state: "running_foreground",
	};
	assert.throws(
		() => parseGatewayEvent({
			jsonrpc: "2.0",
			method: "shell.output",
			params: { ...common, output_delta: "ready\n" },
		}),
		ContractValidationError,
	);
	assert.throws(
		() => parseGatewayEvent({
			jsonrpc: "2.0",
			method: "shell.completed",
			params: { ...common, process_state: "completed" },
		}),
		ContractValidationError,
	);
});
