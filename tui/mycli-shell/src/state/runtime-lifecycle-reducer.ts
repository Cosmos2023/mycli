import type { RuntimeShellState } from "./runtime-state-model.ts";
import type { DecodedRuntimeEvent } from "./runtime-events.ts";
import { runtimeEventTargetsChild } from "./runtime-event-ownership.ts";

type RuntimeLifecyclePatch = Partial<Pick<
	RuntimeShellState,
	| "turnRunning"
	| "sessionGeneration"
	| "activeTurnId"
	| "activeClientTurnId"
	| "activeAssistantItemId"
	| "liveReasoning"
	| "retryRestoreStatus"
>>;

/**
 * Applies lifecycle identity after feature-specific transcript reduction.
 * This keeps display projection from becoming an alternate owner of turn state.
 */
export function reduceRuntimeLifecycle(
	previous: RuntimeShellState,
	reduced: RuntimeShellState,
	event: DecodedRuntimeEvent<string>,
): RuntimeShellState {
	const patch = runtimeLifecyclePatch(previous, event);
	return patch ? { ...reduced, ...patch } : reduced;
}

function runtimeLifecyclePatch(
	state: RuntimeShellState,
	event: DecodedRuntimeEvent<string>,
): RuntimeLifecyclePatch | null {
	const { method, params, ownership } = event;
	if (
		runtimeEventTargetsChild(event)
		&& (
			method === "approval.request"
			|| method === "approval.pending"
			|| method === "approval.respond"
			|| method === "clarify.request"
			|| method === "clarify.respond"
			|| method === "interactive.cancelled"
		)
	) {
		return null;
	}
	if (method === "turn.started") {
		return {
			turnRunning: true,
			sessionGeneration: ownership.generation ?? state.sessionGeneration,
			activeTurnId: ownership.turnId ?? state.activeTurnId,
			activeClientTurnId: ownership.clientTurnId ?? state.activeClientTurnId,
			retryRestoreStatus: null,
		};
	}
	if (
		method === "reasoning.delta" ||
		method === "thinking.delta" ||
		method === "compaction.started" ||
		method === "compaction.completed" ||
		method === "stream.retrying"
	) {
		return { turnRunning: true };
	}
	if (method === "approval.request" || method === "approval.pending" || method === "clarify.request") {
		return { turnRunning: false, activeAssistantItemId: null };
	}
	if (method === "approval.respond" || method === "clarify.respond") {
		return { turnRunning: true };
	}
	if (method === "status.changed") {
		const turnRunning = booleanValue(params.turn_running);
		if (turnRunning === null) return null;
		return {
			turnRunning,
			sessionGeneration: ownership.generation ?? state.sessionGeneration,
			activeTurnId: turnRunning ? ownership.turnId ?? state.activeTurnId : null,
			activeClientTurnId: turnRunning
				? ownership.clientTurnId ?? state.activeClientTurnId
				: null,
			...(turnRunning
				? {}
				: { activeAssistantItemId: null, liveReasoning: null }),
		};
	}
	if (method === "turn.interrupted" && params.requested === true) {
		return { turnRunning: true, retryRestoreStatus: null };
	}
	if (method === "turn.status" || method === "status.update") {
		const status = stringValue(params.state);
		if (!status) return null;
		const terminal = params.terminal === true
			|| status === "completed"
			|| status === "failed"
			|| status === "interrupted"
			|| status === "rejected";
		return terminal
			? terminalPatch(state, event)
			: {
				turnRunning: status === "running"
					|| status === "waiting_approval"
					|| status === "waiting_clarification",
			};
	}
	if (
		method === "turn.completed" ||
		method === "turn.failed" ||
		(method === "turn.interrupted" && params.requested !== true)
	) {
		return terminalPatch(state, event);
	}
	return null;
}

function terminalPatch(
	state: RuntimeShellState,
	event: DecodedRuntimeEvent<string>,
): RuntimeLifecyclePatch | null {
	if (!terminalIdentityMatches(state, event)) return null;
	return {
		turnRunning: false,
		activeTurnId: identityAfterTerminal(
			state.activeTurnId,
			event.ownership.turnId,
			state.activeClientTurnId,
			event.ownership.clientTurnId,
		),
		activeClientTurnId: identityAfterTerminal(
			state.activeClientTurnId,
			event.ownership.clientTurnId,
			state.activeTurnId,
			event.ownership.turnId,
		),
		activeAssistantItemId: null,
		liveReasoning: null,
		retryRestoreStatus: null,
	};
}

function terminalIdentityMatches(
	state: RuntimeShellState,
	event: DecodedRuntimeEvent<string>,
): boolean {
	const { turnId, clientTurnId } = event.ownership;
	if (state.activeTurnId === null && state.activeClientTurnId === null) return true;
	if (turnId !== null && state.activeTurnId !== null && turnId !== state.activeTurnId) return false;
	if (
		clientTurnId !== null &&
		state.activeClientTurnId !== null &&
		clientTurnId !== state.activeClientTurnId
	) return false;
	return (turnId !== null && turnId === state.activeTurnId)
		|| (clientTurnId !== null && clientTurnId === state.activeClientTurnId);
}

function identityAfterTerminal(
	activeIdentity: string | null,
	terminalIdentity: string | null,
	activeFallback: string | null,
	terminalFallback: string | null,
): string | null {
	if (terminalIdentity !== null && terminalIdentity === activeIdentity) return null;
	if (terminalIdentity === null && terminalFallback !== null && terminalFallback === activeFallback) {
		return null;
	}
	return activeIdentity;
}

function booleanValue(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}
