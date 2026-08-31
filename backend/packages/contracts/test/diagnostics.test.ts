import assert from "node:assert/strict";
import test from "node:test";
import {
	DIAGNOSTIC_CATEGORIES,
	DIAGNOSTIC_RECOVERY_ACTION_IDS,
	diagnosticRecoveryAction,
	isDiagnosticCategory,
	isDiagnosticRecoveryActionId,
	requestFailureNoticeId,
	parseGatewayEvent,
	RUNTIME_ERROR_CODES,
	runtimeErrorCategory,
	runtimeErrorRecoveryActions,
} from "../src/index.ts";

test("diagnostic categories and recovery actions are closed and runtime mappings are exhaustive", () => {
	assert.equal(new Set(DIAGNOSTIC_CATEGORIES).size, DIAGNOSTIC_CATEGORIES.length);
	assert.equal(
		new Set(DIAGNOSTIC_RECOVERY_ACTION_IDS).size,
		DIAGNOSTIC_RECOVERY_ACTION_IDS.length,
	);
	for (const category of DIAGNOSTIC_CATEGORIES) assert.equal(isDiagnosticCategory(category), true);
	for (const id of DIAGNOSTIC_RECOVERY_ACTION_IDS) {
		assert.equal(isDiagnosticRecoveryActionId(id), true);
		assert.equal(diagnosticRecoveryAction(id).id, id);
	}
	for (const code of RUNTIME_ERROR_CODES) {
		assert.equal(isDiagnosticCategory(runtimeErrorCategory(code)), true);
		for (const action of runtimeErrorRecoveryActions(code)) {
			assert.equal(isDiagnosticRecoveryActionId(action.id), true);
			assert.ok(action.label.length > 0);
		}
	}
	assert.equal(isDiagnosticCategory("credential"), false);
	assert.equal(isDiagnosticRecoveryActionId("delete_everything"), false);
	for (const id of DIAGNOSTIC_RECOVERY_ACTION_IDS) {
		assert.equal(parseGatewayEvent({
			jsonrpc: "2.0",
			method: "gateway.error",
			params: {
				code: "internal_error",
				message: "Diagnostic test.",
				recovery_actions: [id],
			},
		}).method, "gateway.error");
	}
});

test("request failure notice ids are stable without exposing occurrence values", () => {
	const occurrence = "rpc:private-request-reference";
	const first = requestFailureNoticeId(occurrence);
	assert.equal(first, requestFailureNoticeId(occurrence));
	assert.notEqual(first, requestFailureNoticeId(`${occurrence}-other`));
	assert.doesNotMatch(first, /private-request-reference/u);
});
