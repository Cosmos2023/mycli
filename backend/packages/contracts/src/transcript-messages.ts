import { createHash } from "node:crypto";

export const TURN_INTERRUPTED_NOTICE: string =
	"Turn interrupted. The current turn was aborted; send a new message to continue.";

export function turnInterruptedNoticeId(turnId: string): string {
	const identity = createHash("sha256").update(turnId).digest("hex");
	return `turn-interrupted:${identity}`;
}

export function turnCompletedDurationId(turnId: string): string {
	const identity = createHash("sha256").update(turnId).digest("hex");
	return `turn-completed-duration:${identity}`;
}
