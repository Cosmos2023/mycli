import type { SessionGoal } from "@mycli/contracts";
import type { ProviderUsage } from "../types.ts";

export type GoalStatus = SessionGoal["status"];
export interface GoalRef {
	readonly goalId: string;
	readonly revision: number;
}

export class GoalStateError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "GoalStateError";
	}
}

export function goalReference(goal: SessionGoal): GoalRef {
	return Object.freeze({ goalId: goal.goal_id, revision: goal.revision });
}

export function matchesGoal(goal: SessionGoal | null, ref: GoalRef): goal is SessionGoal {
	return goal !== null && goal.goal_id === ref.goalId && goal.revision === ref.revision;
}

export function goalObjective(value: string): string {
	const objective = value.trim();
	if (!objective || objective.length > 16_384 || objective.includes("\0")) {
		throw new GoalStateError("goal_invalid_objective", "Goal objective must contain between 1 and 16384 characters.");
	}
	return objective;
}

export function goalTokenBudget(value: number | null | undefined): number | null {
	if (value === undefined || value === null) return null;
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new GoalStateError("goal_invalid_budget", "Goal token budget must be a positive integer.");
	}
	return value;
}

export function createSessionGoal(input: {
	readonly current: SessionGoal | null;
	readonly goalId: string;
	readonly objective: string;
	readonly tokenBudget?: number | null;
	readonly now: string;
}): SessionGoal {
	if (input.current && input.current.status !== "complete") {
		throw new GoalStateError("goal_already_exists", "An unfinished goal exists. Edit, resume, or clear it before creating another goal.");
	}
	return Object.freeze({
		goal_id: input.goalId, revision: 1, objective: goalObjective(input.objective), status: "active",
		token_budget: goalTokenBudget(input.tokenBudget), tokens_used: 0, elapsed_ms: 0,
		rounds_started: 0, audit_turns: 0, usage_incomplete: false, created_at: input.now, updated_at: input.now, stop_reason: null,
	});
}

export function changeGoalStatus(goal: SessionGoal, status: GoalStatus, now: string, reason: string | null = null): SessionGoal {
	if (goal.status === status) return goal;
	if (goal.status === "complete" && status !== "complete") {
		throw new GoalStateError("goal_complete", "This goal is complete. Create or edit a goal to start new work.");
	}
	if (status === "active" && goal.token_budget !== null && goal.tokens_used >= goal.token_budget) {
		throw new GoalStateError("goal_budget_exhausted", "Increase or remove the token budget before resuming this goal.");
	}
	return Object.freeze({
		...goal, status, revision: goal.revision + 1, updated_at: now,
		audit_turns: status === "active" ? 0 : goal.audit_turns,
		stop_reason: status === "active" || status === "complete" ? null : reason,
	});
}

/** Codex goal units: uncached input (including cache writes) plus output. */
export function goalUsageTokens(usage: ProviderUsage): number | null {
	if (!validCount(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens)
		|| !validCount(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens)) return null;
	const input = count(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens);
	const output = count(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens);
	if ("cache_creation_input_tokens" in usage || "cache_read_input_tokens" in usage) {
		return addGoalCount(addGoalCount(input, count(usage.cache_creation_input_tokens)), output);
	}
	const cached = count(usage.cached_tokens ?? usage.cached_input_tokens);
	return addGoalCount(Math.max(0, input - cached), output);
}

export function addGoalCount(left: number, right: number): number {
	return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function count(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)) : 0;
}

function validCount(value: number | undefined): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
