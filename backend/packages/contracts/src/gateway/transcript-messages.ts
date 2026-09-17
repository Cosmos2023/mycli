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

export type TurnInterruptionReason = "user" | "goal_budget" | "goal_usage_unavailable" | "goal_changed" | "goal_stopped";

export function isTurnInterruptionReason(value: unknown): value is TurnInterruptionReason {
	return typeof value === "string" && ["user", "goal_budget", "goal_usage_unavailable", "goal_changed", "goal_stopped"].includes(value);
}

export function turnInterruptionNotice(reason?: TurnInterruptionReason): string {
	switch (reason) {
		case "goal_budget": return "Goal token budget reached. The turn was stopped. Increase the budget with /goal budget <tokens>, then /goal resume.";
		case "goal_usage_unavailable": return "Goal stopped because the provider did not report usage. The token budget cannot be checked. Open /goal for details.";
		case "goal_changed": return "The turn stopped because its goal changed. Open /goal to review and resume it.";
		case "goal_stopped": return "The goal stopped. Open /goal to review its status before continuing.";
		default: return TURN_INTERRUPTED_NOTICE;
	}
}
