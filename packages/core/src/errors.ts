export class TurnTransitionError extends Error {
	readonly code = "invalid_turn_transition" as const;

	constructor(from: string, to: string) {
		super(`invalid_turn_transition: cannot transition from ${from} to ${to}`);
		this.name = "TurnTransitionError";
	}
}
