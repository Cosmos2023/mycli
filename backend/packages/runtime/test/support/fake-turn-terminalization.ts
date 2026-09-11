import type {
	StoredTurnTerminalization,
	TerminalizeStoredTurnInput,
	TurnStore,
	TurnTerminalizationStore,
} from "@mycli/storage";

export function fakeTurnTerminalizationStore(
	store: Pick<TurnStore, "completeTurn" | "failTurn">,
): TurnTerminalizationStore {
	const committed = new Map<string, StoredTurnTerminalization>();
	return Object.freeze({
		terminalize(input: TerminalizeStoredTurnInput): StoredTurnTerminalization {
			const turn = input.kind === "completed"
				? store.completeTurn(input)
				: store.failTurn(input);
			const kind = input.kind === "completed"
				? "completed" as const
				: input.code === "interrupted" ? "interrupted" as const : "failed" as const;
			const terminalization = Object.freeze({
				kind,
				turn,
				outbox: Object.freeze({
					schemaVersion: 1,
					sequenceNo: 1,
					sessionId: input.sessionId,
					eventId: `fake-terminal:${turn.turn_id}:${kind}`,
					turnId: turn.turn_id,
					eventType: "turn_lifecycle",
					modelVisible: false,
					createdAt: input.completedAt,
					payload: input.kind === "completed"
						? Object.freeze({
							phase: kind,
							usage: input.usage,
							...(input.lastTokenUsage ? {
								diagnostics: { last_token_usage: input.lastTokenUsage },
							} : {}),
						})
						: Object.freeze({
							phase: kind,
							errorCode: input.code,
							message: input.message,
							...(input.additionalDetails
								? { additionalDetails: input.additionalDetails }
								: {}),
							...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
						}),
				}),
			});
			committed.set(key(input.sessionId, input.clientTurnId), terminalization);
			return terminalization;
		},
		load(sessionId: string, clientTurnId: string): StoredTurnTerminalization | undefined {
			return committed.get(key(sessionId, clientTurnId));
		},
	});
}

function key(sessionId: string, clientTurnId: string): string {
	return `${sessionId}\0${clientTurnId}`;
}
