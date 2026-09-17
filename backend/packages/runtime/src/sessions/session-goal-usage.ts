import type { TurnInterruptionReason } from "@mycli/contracts";
import { matchesGoal, type GoalRef, type ProviderUsage } from "@mycli/core";
import type { SessionGoalService } from "./session-goal-service.ts";

export interface GoalUsageBinding {
	readonly service: SessionGoalService;
	readonly ref: GoalRef;
}

/** Bind delegated work once per turn, including reused children and their descendants. */
export class SessionGoalUsageTracker {
	readonly #inherited = new Map<string, GoalUsageBinding>();

	constructor(private readonly root?: SessionGoalService) {}

	capture(turnId: string): GoalUsageBinding | undefined {
		if (!this.root) return this.#inherited.get(turnId);
		const ref = this.root.usageReference(turnId);
		return ref ? Object.freeze({ service: this.root, ref }) : undefined;
	}

	bind(turnId: string, binding: GoalUsageBinding | undefined): void {
		if (binding) this.#inherited.set(turnId, binding);
		else this.#inherited.delete(turnId);
	}

	release(turnId: string): void { this.#inherited.delete(turnId); }

	observe(turnId: string, requestId: string, usage: ProviderUsage): void {
		const binding = this.#inherited.get(turnId);
		binding?.service.observeAttributedUsage(binding.ref.goalId, requestId, usage);
	}

	interruptionReason(turnId: string): TurnInterruptionReason {
		const binding = this.#inherited.get(turnId);
		const goal = binding?.service.get() ?? null;
		if (!binding || !matchesGoal(goal, binding.ref)) return "goal_changed";
		return goal.status === "budget_limited" ? goal.usage_incomplete ? "goal_usage_unavailable" : "goal_budget" : "goal_stopped";
	}

	stopReason(turnId: string): string | undefined {
		const binding = this.#inherited.get(turnId);
		if (!binding) return undefined;
		const halted = binding.service.executionHaltReason();
		if (halted) return halted;
		const goal = binding.service.get();
		if (!matchesGoal(goal, binding.ref)) return "The parent goal changed while this task was running.";
		return goal.status === "active" ? undefined : goal.stop_reason ?? `The parent goal is ${goal.status}.`;
	}
}
