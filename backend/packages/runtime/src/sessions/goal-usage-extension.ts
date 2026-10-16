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
		tokenUsage: {
			onTokenUsage: ({ turnId, requestId, usage }) => {
				options.tracker.observe(turnId, requestId, usage);
			},
		},
		compactionBudget: {
			compactionBudget: ({ turnId }) => {
				// The binding is captured once, so a goal that stops mid-compaction keeps being charged.
				const binding = turnId === undefined ? undefined : options.tracker.capture(turnId);
				if (!binding) return undefined;
				return {
					remainingTokenBudget: () => binding.service.remainingTokenBudget(binding.ref.goalId),
					observeUsage: (requestId, usage) => {
						binding.service.observeAttributedUsage(binding.ref.goalId, requestId, usage);
					},
				};
			},
		},
	};
}
