import assert from "node:assert/strict";
import test from "node:test";
import { parseGatewayParams, parseGatewayResult, GatewayRpcValidationError } from "../../src/index.ts";

const scope = { session_id: "session", generation: 1, operation_id: "operation" };
test("plugin mutations require explicit ownership, source identity and closed action variants", () => {
	for (const action of ["install", "enable", "disable", "remove", "update", "marketplace_upgrade", "marketplace_remove"]) {
		const input = { ...scope, change: { action, target: "plugin@personal", revision: "a".repeat(64) } };
		assert.deepEqual(parseGatewayParams("plugin.operation.start", input), input);
		for (const change of [{ action, target: "plugin" }, { ...input.change, revision: "stale" }, { ...input.change, source: "private" }]) {
			assert.throws(() => parseGatewayParams("plugin.operation.start", { ...scope, change }), GatewayRpcValidationError);
		}
	}
	for (const action of ["install_source", "marketplace_add"]) {
		const input = { ...scope, change: { action, source: "/tmp/plugins" } };
		assert.deepEqual(parseGatewayParams("plugin.operation.start", input), input);
		assert.throws(() => parseGatewayParams("plugin.operation.start", { ...input, generation: 0 }), GatewayRpcValidationError);
		assert.throws(() => parseGatewayParams("plugin.operation.start", { ...input, change: { action, source: "x".repeat(4097) } }), GatewayRpcValidationError);
	}
});

test("plugin catalog and operation outcomes reject unbounded or executable payloads", () => {
	const catalog = { plugins: [], marketplaces: [], issues: [], truncated: false, repository_enabled: false };
	assert.deepEqual(parseGatewayResult("plugin.catalog", catalog), catalog);
	assert.throws(() => parseGatewayResult("plugin.catalog", { ...catalog, credentials: "private" }), GatewayRpcValidationError);
	assert.throws(() => parseGatewayResult("plugin.operation.get", { operation_id: "op", state: "loaded", message: "", issues: [] }), GatewayRpcValidationError);
	for (const state of ["running", "completed", "failed", "cancelled"]) {
		const outcome = { operation_id: "op", state, message: "operation result", issues: [] };
		assert.deepEqual(parseGatewayResult("plugin.operation.get", outcome), outcome);
	}
});
