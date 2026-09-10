export class UserTurnCancellation extends Error {
	constructor() {
		super("turn interrupted by user");
		this.name = "AbortError";
	}
}

export function assertNotAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		if (signal.reason instanceof UserTurnCancellation) throw signal.reason;
		const error = new Error("interrupted: turn aborted");
		error.name = "AbortError";
		throw error;
	}
}
