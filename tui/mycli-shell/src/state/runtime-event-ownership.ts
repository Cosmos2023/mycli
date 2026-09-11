import type { DecodedRuntimeEvent, RuntimeEventMethod } from "./runtime-events.ts";

export type RuntimeEventOwnerState = Readonly<{
	sessionId: string | null;
	sessionGeneration: number | null;
	turnRunning: boolean;
	activeTurnId: string | null;
	activeClientTurnId: string | null;
}>;

const TURN_SCOPED_METHODS = new Set<RuntimeEventMethod>([
	"compaction.completed",
	"compaction.started",
	"item.completed",
	"item.started",
	"message.complete",
	"message.delta",
	"message.reset",
	"plan.proposed",
	"plan.updated",
	"provider.attempt.updated",
	"reasoning.delta",
	"status.update",
	"stream.recovered",
	"stream.retrying",
	"thinking.delta",
	"tool.complete",
	"tool.failed",
	"tool.progress",
	"tool.start",
	"turn.completed",
	"turn.completion_suppressed",
	"turn.event",
	"turn.failed",
	"turn.interrupted",
	"turn.started",
	"turn.status",
]);

const UNFENCED_METHODS = new Set<RuntimeEventMethod>([
	"session.changed",
]);

export function runtimeEventBelongsToActiveOwner(
	state: RuntimeEventOwnerState,
	event: DecodedRuntimeEvent<string>,
): boolean {
	if (UNFENCED_METHODS.has(event.method as RuntimeEventMethod)) return true;
	if (!sessionOwnershipMatches(state, event)) return false;
	if (!TURN_SCOPED_METHODS.has(event.method as RuntimeEventMethod)) return true;
	if (!terminalEventCorrelatesToActiveIdentity(state, event)) return false;
	return turnOwnershipMatches(state, event);
}

export function runtimeEventTargetsChild(
	event: DecodedRuntimeEvent<string>,
): boolean {
	const childSessionId = stringValue(event.params.child_session_id)
		?? stringValue(event.params.childSessionId);
	if (childSessionId !== null) return true;
	const subjectSessionId = stringValue(event.params.session_id)
		?? stringValue(event.params.sessionId);
	return subjectSessionId !== null
		&& event.ownership.sessionId !== null
		&& subjectSessionId !== event.ownership.sessionId;
}

function terminalEventCorrelatesToActiveIdentity(
	state: RuntimeEventOwnerState,
	event: DecodedRuntimeEvent<string>,
): boolean {
	if (!runtimeEventTerminatesTurn(event)) return true;
	if (state.activeTurnId === null && state.activeClientTurnId === null) return true;
	const turnMatches = event.ownership.turnId !== null
		&& state.activeTurnId !== null
		&& event.ownership.turnId === state.activeTurnId;
	const clientTurnMatches = event.ownership.clientTurnId !== null
		&& state.activeClientTurnId !== null
		&& event.ownership.clientTurnId === state.activeClientTurnId;
	return turnMatches || clientTurnMatches;
}

function runtimeEventTerminatesTurn(event: DecodedRuntimeEvent<string>): boolean {
	if (event.method === "turn.completed" || event.method === "turn.failed") return true;
	if (event.method === "turn.interrupted") return event.params.requested !== true;
	if (event.method !== "turn.status" && event.method !== "status.update") return false;
	const state = typeof event.params.state === "string" ? event.params.state : "";
	return event.params.terminal === true
		|| state === "completed"
		|| state === "failed"
		|| state === "interrupted"
		|| state === "rejected";
}

function sessionOwnershipMatches(
	state: RuntimeEventOwnerState,
	event: DecodedRuntimeEvent<string>,
): boolean {
	const { sessionId, generation } = event.ownership;
	if (sessionId !== null && state.sessionId !== null && sessionId !== state.sessionId) {
		return false;
	}
	return generation === null
		|| state.sessionGeneration === null
		|| generation === state.sessionGeneration;
}

function turnOwnershipMatches(
	state: RuntimeEventOwnerState,
	event: DecodedRuntimeEvent<string>,
): boolean {
	const { turnId, clientTurnId } = event.ownership;
	if (
		turnId !== null &&
		state.activeTurnId !== null &&
		turnId !== state.activeTurnId
	) {
		return false;
	}
	if (
		clientTurnId !== null &&
		state.activeClientTurnId !== null &&
		clientTurnId !== state.activeClientTurnId
	) {
		return false;
	}
	if (event.method !== "turn.started" || !state.turnRunning) return true;
	return turnId !== null || clientTurnId !== null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}
