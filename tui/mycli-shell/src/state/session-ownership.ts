import { generationValue, stringValue } from "./payload-values.ts";
import type { RuntimeShellState } from "./runtime-state-model.ts";

export function activeTurnIdAfterTerminal(
	state: RuntimeShellState,
	params: Record<string, unknown>,
): string | null {
	const terminalTurnId = stringValue(params.turn_id);
	const terminalClientTurnId = stringValue(params.client_turn_id);
	if (
		(terminalTurnId !== null && terminalTurnId === state.activeTurnId)
		|| (terminalTurnId === null
			&& terminalClientTurnId !== null
			&& terminalClientTurnId === state.activeClientTurnId)
	) {
		return null;
	}
	return state.activeTurnId;
}

export function activeClientTurnIdAfterTerminal(
	state: RuntimeShellState,
	params: Record<string, unknown>,
): string | null {
	const terminalTurnId = stringValue(params.turn_id);
	const terminalClientTurnId = stringValue(params.client_turn_id);
	if (
		(terminalClientTurnId !== null && terminalClientTurnId === state.activeClientTurnId)
		|| (terminalClientTurnId === null
			&& terminalTurnId !== null
			&& terminalTurnId === state.activeTurnId)
	) {
		return null;
	}
	return state.activeClientTurnId;
}

export function eventBelongsToActiveSession(
	state: RuntimeShellState,
	params: Record<string, unknown>,
): boolean {
	const sessionId = stringValue(params.session_id) ?? stringValue(params.sessionId);
	if (sessionId !== null && state.sessionId !== null && sessionId !== state.sessionId) {
		return false;
	}
	const generation = generationValue(params.generation);
	return generation === null
		|| state.sessionGeneration === null
		|| generation === state.sessionGeneration;
}

export function sessionChangeCanApply(
	state: RuntimeShellState,
	nextSessionId: string | null,
	nextGeneration: number | null,
): boolean {
	if (nextGeneration === null || state.sessionGeneration === null) return true;
	return nextGeneration > state.sessionGeneration
		|| (nextGeneration === state.sessionGeneration && nextSessionId === state.sessionId);
}

export function statusSnapshotBelongsToActiveSession(
	state: RuntimeShellState,
	params: Record<string, unknown>,
): boolean {
	const sessionId = stringValue(params.session_id) ?? stringValue(params.sessionId);
	if (sessionId !== null && state.sessionId !== null && sessionId !== state.sessionId) {
		return false;
	}
	const generation = generationValue(params.generation);
	return generation === null
		|| state.sessionGeneration === null
		|| generation >= state.sessionGeneration;
}
