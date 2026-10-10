import assert from "node:assert/strict";
import test from "node:test";
import {
	formatGoalElapsed,
	formatGoalTokensCompact,
	goalStatusUsage,
	goalSummaryLines,
	parseSessionGoal,
} from "../src/index.ts";

const goal = parseSessionGoal({
	goal_id: "goal", revision: 4, objective: "Ship the migration", status: "active",
	token_budget: 50_000, tokens_used: 12_500, elapsed_ms: 90_000, rounds_started: 3, audit_turns: 1,
	created_at: "2026-09-14T00:00:00Z", updated_at: "2026-09-14T00:00:00Z", stop_reason: null, usage_incomplete: false,
});

test("goal tokens scale compactly and keep two significant decimals", () => {
	assert.equal(formatGoalTokensCompact(0), "0");
	assert.equal(formatGoalTokensCompact(999), "999");
	assert.equal(formatGoalTokensCompact(1_250), "1.25K");
	assert.equal(formatGoalTokensCompact(12_500), "12.5K");
	assert.equal(formatGoalTokensCompact(50_000), "50K");
	assert.equal(formatGoalTokensCompact(63_876), "63.9K");
	assert.equal(formatGoalTokensCompact(2_400_000), "2.4M");
});

test("goal elapsed time follows seconds, minutes, hours and days", () => {
	assert.equal(formatGoalElapsed(0), "0s");
	assert.equal(formatGoalElapsed(59_000), "59s");
	assert.equal(formatGoalElapsed(90_000), "1m");
	assert.equal(formatGoalElapsed(90 * 60_000), "1h 30m");
	assert.equal(formatGoalElapsed(2 * 60 * 60_000), "2h");
	assert.equal(formatGoalElapsed(24 * 60 * 60_000), "1d 0h 0m");
});

test("goal status usage reports budget, elapsed time and stop states", () => {
	assert.equal(goalStatusUsage(goal), "12.5K / 50K");
	assert.equal(goalStatusUsage({ ...goal, token_budget: null }), "1m");
	assert.equal(goalStatusUsage({ ...goal, status: "budget_limited", tokens_used: 63_876 }), "63.9K / 50K tokens");
	assert.equal(goalStatusUsage({ ...goal, status: "complete", tokens_used: 40_000 }), "40K tokens");
	assert.equal(goalStatusUsage({ ...goal, status: "paused" }), undefined);
});

test("goal summary lists accounting and the controls that fit the status", () => {
	const summary = goalSummaryLines(goal).join("\n");

	assert.match(summary, /^Status: active$/mu);
	assert.match(summary, /^Objective: Ship the migration$/mu);
	assert.match(summary, /^Time used: 1m$/mu);
	assert.match(summary, /^Tokens used: 12\.5K$/mu);
	assert.match(summary, /^Token budget: 50K$/mu);
	assert.match(summary, /^Continuations: 3$/mu);
	assert.match(summary, /^Commands: \/goal edit, \/goal pause, \/goal budget, \/goal clear$/mu);
	assert.match(goalSummaryLines({ ...goal, status: "paused" }).join("\n"), /Commands: \/goal edit, \/goal resume/);
	assert.match(goalSummaryLines({ ...goal, status: "complete" }).join("\n"), /Commands: \/goal edit, \/goal budget, \/goal clear/);
});
