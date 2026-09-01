import assert from "node:assert/strict";
import test from "node:test";
import {
	gatewayContractCatalog,
	isModelSelectionScope,
	MODEL_SELECTION_SCOPES,
} from "../src/index.ts";

test("catalog exposes the versioned current gateway surface", () => {
	assert.equal(gatewayContractCatalog.protocolVersion, 1);
	assert.ok(gatewayContractCatalog.rpcMethods.includes("session.bootstrap"));
	assert.ok(gatewayContractCatalog.rpcMethods.includes("session.new"));
	assert.ok(gatewayContractCatalog.rpcMethods.includes("turn.submit"));
	assert.ok(gatewayContractCatalog.rpcMethods.includes("update.status"));
	assert.ok(gatewayContractCatalog.rpcMethods.includes("update.dismiss"));
	assert.ok(gatewayContractCatalog.rpcMethods.includes("settings.keymap.reset"));
	assert.ok(gatewayContractCatalog.eventStreams.includes("turn.started"));
	assert.ok(gatewayContractCatalog.eventStreams.includes("runtime.ready"));
	assert.ok(gatewayContractCatalog.eventStreams.includes("shell.started"));
	assert.ok(gatewayContractCatalog.eventStreams.includes("shell.completed"));
	assert.ok(gatewayContractCatalog.errorCodes.includes("incompatible_protocol"));
	assert.deepEqual(gatewayContractCatalog.modelSelectionScopes, ["session", "user"]);
	assert.deepEqual(MODEL_SELECTION_SCOPES, ["session", "user"]);
	assert.equal(isModelSelectionScope("session"), true);
	assert.equal(isModelSelectionScope("user"), true);
	assert.equal(isModelSelectionScope("project"), false);
});

test("catalog exposes M5 session and approval failures", () => {
	for (const code of [
		"session_not_found",
		"session_in_use",
		"session_state_invalid",
		"session_state_version_unsupported",
		"approval_not_pending",
		"approval_conflict",
	]) {
		assert.ok(gatewayContractCatalog.errorCodes.includes(code), code);
	}
});
