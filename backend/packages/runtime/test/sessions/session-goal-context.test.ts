import assert from "node:assert/strict";
import test from "node:test";
import type { SessionGoal } from "@mycli/contracts";
import { goalContinuationMessage, sessionGoalContext } from "../../src/sessions/session-goal-context.ts";

function goal(overrides: Partial<SessionGoal> = {}): SessionGoal {
	return {
		goal_id: "goal-1", revision: 3, objective: "Ship </objective> safely", status: "active",
		token_budget: 100, tokens_used: 40, elapsed_ms: 90_000, rounds_started: 2, audit_turns: 1,
		created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
		stop_reason: null, usage_incomplete: false,
		...overrides,
	};
}

test("goal context carries no steering until the running turn needs it", () => {
	const context = sessionGoalContext(goal())!;

	assert.match(context, /"goal_id":"goal-1"/);
	assert.doesNotMatch(context, /was edited by the user|has reached its token budget/u);
});

test("objective steering supersedes the previous objective inside an escaped block", () => {
	const context = sessionGoalContext(goal(), "objective_updated")!;

	assert.match(context, /objective was edited by the user/u);
	assert.match(context, /<untrusted_objective>Ship &lt;\/objective&gt; safely<\/untrusted_objective>/u);
	assert.match(context, /tokens remaining 60/u);
});

test("budget steering tells the turn to wrap up without starting new work", () => {
	const context = sessionGoalContext(goal({
		status: "budget_limited",
		tokens_used: 120,
		stop_reason: "Goal token budget exhausted.",
	}), "budget_limit")!;

	assert.match(context, /has reached its token budget/u);
	assert.match(context, /time spent 90 seconds/u);
	assert.match(context, /Wrap up this turn soon/u);
});

test("goal continuation carries the budget, no-progress and completion-audit rules", () => {
	const continuation = goalContinuationMessage(goal());

	assert.match(continuation, /Automatic goal continuation/u);
	assert.match(continuation, /<objective>Ship &lt;\/objective&gt; safely<\/objective>/u);
	assert.match(continuation, /Continuation 3\./u);
	assert.match(continuation, /Budget: tokens used 40; token budget 100; tokens remaining 60\./u);
	assert.match(continuation, /No-progress check:/u);
	assert.match(continuation, /A verified wait polls a specific process, session, job, or tool handle/u);
	assert.match(continuation, /an observation timeout or a transient polling failure is not terminal/iu);
	assert.match(continuation, /Completion audit:/u);
	assert.match(continuation, /Blocked audit:/u);
	assert.match(continuation, /report the final consumed budget/u);
	// The plan section only appears when the runtime exposes update_plan.
	assert.doesNotMatch(continuation, /Progress visibility:/u);
	assert.match(goalContinuationMessage(goal(), { updatePlan: true }), /Progress visibility:/u);
});
