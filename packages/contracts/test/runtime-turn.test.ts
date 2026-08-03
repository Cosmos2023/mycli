import assert from "node:assert/strict";
import test from "node:test";
import * as contracts from "../src/index.ts";

const completedTurn = {
	schema_version: 1,
	session_id: "session-1",
	client_turn_id: "client-1",
	turn_id: "turn-1",
	request_fingerprint: "sha256:abc",
	status: "completed",
	error_code: null,
	result: { assistant_text: "ok" },
	started_at: "2026-08-03T00:00:00.000Z",
	completed_at: "2026-08-03T00:00:01.000Z",
} as const;

test("validates a completed durable runtime turn", () => {
	const parser = Reflect.get(contracts, "parseRuntimeTurnRecord");
	assert.equal(typeof parser, "function");
	const turn = Reflect.apply(parser as (...args: unknown[]) => unknown, undefined, [completedTurn]);
	assert.deepEqual(turn, completedTurn);
});

test("accepts a typed turn.failed notification", () => {
	assert.doesNotThrow(() => contracts.parseGatewayEvent({
		jsonrpc: "2.0",
		method: "turn.failed",
		params: {
			client_turn_id: "client-1",
			turn_id: "turn-1",
			message: "Authentication failed.",
			code: "auth_error",
		},
	}));
});

test("rejects an unknown turn.failed error code", () => {
	assert.throws(() => contracts.parseGatewayEvent({
		jsonrpc: "2.0",
		method: "turn.failed",
		params: {
			client_turn_id: "client-1",
			turn_id: "turn-1",
			message: "Failed.",
			code: "credential_dump",
		},
	}));
});
