import assert from "node:assert/strict";
import test from "node:test";
import { parseSessionGoal } from "@mycli/contracts";
import { goalInstructionItem } from "../src/node-runtime/goal-instruction.ts";

function goal(overrides: Record<string, unknown> = {}) {
	return parseSessionGoal({
		goal_id: "goal-1", revision: 2, objective: "Ship the migration", status: "active",
		token_budget: null, tokens_used: 0, elapsed_ms: 0, rounds_started: 0, audit_turns: 0,
		created_at: "2026-10-10T06:00:00.000Z", updated_at: "2026-10-10T06:00:00.000Z",
		stop_reason: null, usage_incomplete: false,
		...overrides,
	});
}

test("a user goal change becomes a model-visible instruction with provenance", () => {
	const item = goalInstructionItem({ action: "create", previous: null, goal: goal() })!;

	assert.equal(item.itemId, "goal:goal-1:instruction:2");
	assert.equal(item.metadata.kind, "user_goal");
	assert.equal(item.metadata.role, "user");
	assert.equal(item.metadata.scope, "session");
	assert.equal(item.metadata.sourceId, "goal");
	assert.match(item.text, /The user set this session's goal objective/u);
	assert.match(item.text, /Ship the migration/u);
	assert.equal(item.metadata.contentLength, item.text.length);
	assert.match(item.metadata.contentSha256, /^[a-f0-9]{64}$/u);
});

test("pause, resume and clear keep the user's own wording", () => {
	const paused = goalInstructionItem({
		action: "pause", previous: goal(), goal: goal({ status: "paused", revision: 3 }),
	})!;
	const resumed = goalInstructionItem({
		action: "resume", previous: goal({ status: "paused" }), goal: goal({ revision: 3 }),
	})!;
	const cleared = goalInstructionItem({ action: "clear", previous: goal(), goal: null })!;

	assert.match(paused.text, /The user paused this session's goal/u);
	assert.match(resumed.text, /The user resumed this session's goal/u);
	assert.match(cleared.text, /The user cleared this session's goal/u);
	assert.equal(cleared.itemId, "goal:goal-1:instruction:3");
});

test("an oversized objective is referenced instead of copied", () => {
	const item = goalInstructionItem({
		action: "edit", previous: goal(), goal: goal({ revision: 3, objective: "R".repeat(5_000) }),
	})!;

	assert.match(item.text, /Read the current objective with get_goal/u);
	assert.doesNotMatch(item.text, /RRRR/u);
});
