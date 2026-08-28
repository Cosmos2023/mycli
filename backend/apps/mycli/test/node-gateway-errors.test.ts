import assert from "node:assert/strict";
import test from "node:test";
import { SlashCommandError } from "../src/node-runtime/node-slash-command-registry.ts";
import {
	GatewayFailure,
	gatewayFailure,
} from "../src/node-runtime/node-gateway-errors.ts";

test("gateway failures keep request errors separate from turn failures", () => {
	const existing = new GatewayFailure("invalid_params", "Specific request failure.", { field: "model" });
	assert.equal(gatewayFailure(existing), existing);
	assert.deepEqual(failureValue(gatewayFailure(new SlashCommandError(
		"invalid_arguments",
		"Use /model <name>.",
	))), {
		code: "invalid_arguments",
		message: "Use /model <name>.",
		data: {},
	});
	assert.deepEqual(failureValue(gatewayFailure({ code: "persistence_error" })), {
		code: "persistence_error",
		message: "Session persistence failed.",
		data: {},
	});
	assert.deepEqual(failureValue(gatewayFailure({ code: "session_in_use" })), {
		code: "session_in_use",
		message: "Session is already open in another mycli window.",
		data: {},
	});
});

test("gateway failures contain arbitrary local exceptions", () => {
	assert.deepEqual(failureValue(gatewayFailure(new Error("private local stack detail"))), {
		code: "internal_error",
		message: "Gateway request failed.",
		data: {},
	});
});

function failureValue(failure: GatewayFailure): Record<string, unknown> {
	return {
		code: failure.code,
		message: failure.message,
		data: failure.data,
	};
}
