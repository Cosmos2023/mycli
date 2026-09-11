import { diagnosticRecoveryAction, errorDefinition } from "@mycli/contracts";
import type { DiagnosticRecoveryAction, DiagnosticRecoveryActionId, ErrorContext, RuntimeFailure } from "@mycli/contracts";

export interface RecoveryState {
	readonly ownershipCurrent: boolean;
	readonly connected: boolean;
	readonly activeOperation: boolean;
	readonly effects: "none" | "completed" | "unknown";
	readonly imageInput: "supported" | "unsupported" | "unknown";
	readonly availableActions: readonly DiagnosticRecoveryActionId[];
}

export function resolveErrorRecovery(context: ErrorContext, state: RecoveryState): readonly DiagnosticRecoveryAction[] {
	const candidates = errorDefinition(context.reason).recovery;
	const uncertain = context.outcome.state === "unknown" || context.outcome.effects === "possible"
		|| state.effects === "unknown" || !state.connected;
	const ids = uncertain ? ["inspect_execution" as const, ...candidates] : candidates;
	return Object.freeze([...new Set(ids)].filter((id) => {
		if (!state.availableActions.includes(id)) return false;
		if (id === "retry" || id === "wait_and_retry") return state.ownershipCurrent && state.connected
			&& !state.activeOperation && !uncertain && state.effects === "none"
			&& context.outcome.effects === "none" && context.outcome.state !== "completed"
			&& context.outcome.state !== "cancelled";
		if (id === "compact_session" || id === "start_new_session") return state.ownershipCurrent && !state.activeOperation;
		if (id === "select_compatible_model") return state.ownershipCurrent && !state.activeOperation
			&& !(context.reason === "capability.image_input_unsupported" && state.imageInput === "supported");
		return true;
	}).map(diagnosticRecoveryAction));
}

export function providerAttemptRetryAllowed(failure: RuntimeFailure, state: {
	readonly completed: boolean;
	readonly cancelled: boolean;
	readonly effectsDispatched: boolean;
}): boolean {
	if (!failure.retryable || state.completed || state.cancelled || state.effectsDispatched
		|| failure.diagnostics?.error_context_invalid === true) return false;
	if (!["connection_error", "response_stream_error", "server_overloaded", "rate_limited", "provider_error"].includes(failure.code)) return false;
	const context = failure.errorContext;
	if (!context) return true;
	return context.scope.kind === "provider_attempt" && context.outcome.effects === "none"
		&& (context.outcome.state === "failed" || context.outcome.state === "not_started")
		&& (context.reason.startsWith("transport.") || context.reason === "provider.overloaded"
			|| context.reason === "provider.rate_limited" || context.reason === "provider.service_failed"
			|| context.reason === "provider.failure_unclassified");
}
