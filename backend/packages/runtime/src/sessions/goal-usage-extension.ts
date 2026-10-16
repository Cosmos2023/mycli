import type { ExtensionDefinition } from "@mycli/extensions";
import type { SessionGoalUsageTracker } from "./session-goal-usage.ts";

export interface GoalUsageExtensionOptions {
	readonly tracker: SessionGoalUsageTracker;
}

/**
 * The delegated-work half of goal accounting. A subagent runtime carries no goal service of its
 * own, so this extension mirrors the parent goal the work was bound to and stops the child turn
 * once that goal is no longer running.
 */
export function createGoalUsageExtension(options: GoalUsageExtensionOptions): ExtensionDefinition {
	const stop = (turnId: string) => {
		const message = options.tracker.stopReason(turnId);
		return message === undefined ? undefined : {
			message,
			interruptionReason: options.tracker.interruptionReason(turnId),
		};
	};
	return {
		id: "goal-usage",
		turnPolicy: {
			stopReason: ({ turnId }) => stop(turnId),
			toolsStopReason: ({ turnId }) => stop(turnId),
		},
	};
}
