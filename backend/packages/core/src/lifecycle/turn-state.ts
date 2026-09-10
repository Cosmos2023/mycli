import { TurnTransitionError } from "../errors.ts";
import type { ProviderUsage, RuntimeErrorCode, TurnSnapshot } from "../types.ts";

export interface StartTurnInput {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly turnId: string;
	readonly startedAt: string;
}

export interface CompleteTurnInput {
	readonly assistantText: string;
	readonly completedAt: string;
	readonly usage?: ProviderUsage;
}

export interface FailTurnInput {
	readonly code: RuntimeErrorCode;
	readonly message: string;
	readonly completedAt: string;
}

function requireRunning(turn: TurnSnapshot, target: string): void {
	if (turn.status !== "in_progress") {
		throw new TurnTransitionError(turn.status, target);
	}
}

export function startTurn(input: StartTurnInput): TurnSnapshot {
	return Object.freeze({
		...input,
		status: "in_progress" as const,
	});
}

export function completeTurn(turn: TurnSnapshot, input: CompleteTurnInput): TurnSnapshot {
	requireRunning(turn, "completed");
	return Object.freeze({
		...turn,
		status: "completed" as const,
		completedAt: input.completedAt,
		assistantText: input.assistantText,
		usage: input.usage ?? {},
	});
}

export function failTurn(turn: TurnSnapshot, input: FailTurnInput): TurnSnapshot {
	requireRunning(turn, "failed");
	return Object.freeze({
		...turn,
		status: "failed" as const,
		completedAt: input.completedAt,
		errorCode: input.code,
		errorMessage: input.message,
	});
}
