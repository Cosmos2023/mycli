import assert from "node:assert/strict";
import test from "node:test";
import { createErrorContext, DIAGNOSTIC_RECOVERY_ACTION_IDS } from "@mycli/contracts";
import { providerAttemptRetryAllowed, resolveErrorRecovery } from "../../src/errors/recovery.ts";
import type { RecoveryState } from "../../src/errors/recovery.ts";

const state: RecoveryState = { ownershipCurrent: true, connected: true, activeOperation: false,
	effects: "none", imageInput: "unsupported", availableActions: DIAGNOSTIC_RECOVERY_ACTION_IDS,
};

test("recovery inspects uncertain effects and never offers operation replay", () => {
	const context = createErrorContext({ reason: "transport.connect_failed", source: "provider",
		scope: { kind: "provider_attempt", id: "attempt:1" }, outcome: { state: "failed", effects: "none" },
	});
	assert.deepEqual(resolveErrorRecovery(context, state).map((action) => action.id), ["retry"]);
	assert.deepEqual(resolveErrorRecovery(context, { ...state, effects: "unknown" }).map((action) => action.id), ["inspect_execution"]);
	assert.deepEqual(resolveErrorRecovery(context, { ...state, effects: "completed" }), []);
	assert.deepEqual(resolveErrorRecovery(context, { ...state, ownershipCurrent: false }), []);
	assert.deepEqual(resolveErrorRecovery(context, { ...state, availableActions: [] }), []);
});

test("model recovery is refreshed against current capability and ownership", () => {
	const context = createErrorContext({ reason: "capability.image_input_unsupported", source: "provider",
		scope: { kind: "provider_attempt", id: "attempt:1" }, outcome: { state: "not_started", effects: "none" },
	});
	assert.equal(resolveErrorRecovery(context, state)[0]?.command, "/model");
	assert.deepEqual(resolveErrorRecovery(context, { ...state, imageInput: "supported" }), []);
	assert.deepEqual(resolveErrorRecovery(context, { ...state, activeOperation: true }), []);
});

test("retryable alone cannot override cancellation, completed output, effects, or unknown extensions", () => {
	const failure = { code: "connection_error" as const, message: "connection failed", retryable: true };
	const attempt = { completed: false, cancelled: false, effectsDispatched: false };
	assert.equal(providerAttemptRetryAllowed(failure, attempt), true);
	for (const key of ["completed", "cancelled", "effectsDispatched"] as const) {
		assert.equal(providerAttemptRetryAllowed(failure, { ...attempt, [key]: true }), false);
	}
	assert.equal(providerAttemptRetryAllowed({ ...failure, diagnostics: { error_context_invalid: true } }, attempt), false);
	assert.equal(providerAttemptRetryAllowed({ ...failure, code: "unsupported_capability" }, attempt), false);
});
