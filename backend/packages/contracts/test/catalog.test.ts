import assert from "node:assert/strict";
import test from "node:test";
import { gatewayContractCatalog } from "../src/index.ts";

test("catalog exposes the versioned current gateway surface", () => {
	assert.equal(gatewayContractCatalog.protocolVersion, 1);
	assert.ok(gatewayContractCatalog.rpcMethods.includes("session.bootstrap"));
	assert.ok(gatewayContractCatalog.rpcMethods.includes("turn.submit"));
	assert.ok(gatewayContractCatalog.eventStreams.includes("turn.started"));
	assert.ok(gatewayContractCatalog.eventStreams.includes("runtime.ready"));
	assert.ok(gatewayContractCatalog.eventStreams.includes("shell.started"));
	assert.ok(gatewayContractCatalog.eventStreams.includes("shell.completed"));
	assert.ok(gatewayContractCatalog.errorCodes.includes("incompatible_protocol"));
});

test("catalog exposes M5 session and approval failures", () => {
	for (const code of [
		"session_not_found",
		"session_state_invalid",
		"session_state_version_unsupported",
		"approval_not_pending",
		"approval_conflict",
	]) {
		assert.ok(gatewayContractCatalog.errorCodes.includes(code), code);
	}
});
