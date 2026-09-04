import { runtimeErrorPublicMessage } from "@mycli/contracts";
import type { RuntimeEvent } from "@mycli/core";
import type { StoredTurnTerminalization } from "@mycli/storage";

export type TurnTerminalRuntimeEvent = Extract<RuntimeEvent, {
	readonly type: "turn_completed" | "turn_failed" | "turn_interrupted";
}>;

export function projectCommittedTurnTerminalization(
	terminalization: StoredTurnTerminalization,
): TurnTerminalRuntimeEvent {
	const { outbox, turn } = terminalization;
	if (terminalization.kind === "completed") {
		const assistantText = typeof turn.result?.assistant_text === "string"
			? turn.result.assistant_text
			: "";
		return Object.freeze({
			type: "turn_completed",
			assistantText,
			usage: outbox.payload.usage ?? Object.freeze({}),
			durationMs: completedTurnDurationMs(turn.started_at, turn.completed_at),
		});
	}
	const code = outbox.payload.errorCode ?? turn.error_code ?? "persistence_error";
	const message = outbox.payload.message ?? runtimeErrorPublicMessage(code);
	if (terminalization.kind === "interrupted") {
		return Object.freeze({ type: "turn_interrupted", message });
	}
	return Object.freeze({
		type: "turn_failed",
		code,
		message,
		...(outbox.payload.additionalDetails
			? { additionalDetails: outbox.payload.additionalDetails }
			: {}),
	});
}

function completedTurnDurationMs(startedAt: string, completedAt: string | null): number {
	const started = Date.parse(startedAt);
	const completed = completedAt === null ? Number.NaN : Date.parse(completedAt);
	const elapsed = completed - started;
	if (!Number.isFinite(elapsed)) return 0;
	return Math.min(86_400_000, Math.max(0, Math.round(elapsed)));
}
