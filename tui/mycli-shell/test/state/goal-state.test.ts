import assert from "node:assert/strict";
import test from "node:test";
import { parseSessionGoal } from "@mycli/contracts";
import { initialRuntimeState, type RuntimeShellState } from "../../src/state/runtime-state-model.ts";
import { reduceRuntimeEvent } from "../../src/state/runtime-event-reducer.ts";
import { projectRuntimeState } from "../../src/state/runtime-projection.ts";
import { renderGoalStatus } from "../../src/components/composer/goal-status.ts";
import { visibleWidth } from "../../src/tui-core/utils.ts";

const goal = parseSessionGoal({ goal_id: "goal", revision: 1, objective: "修复文档渲染和回放", status: "active",
	token_budget: 50000, tokens_used: 1250, elapsed_ms: 1000, rounds_started: 2, audit_turns: 3,
	created_at: "2026-09-14T00:00:00Z", updated_at: "2026-09-14T00:00:00Z", stop_reason: null, usage_incomplete: false });

test("goal status is projected from session ownership and clears on session change", () => {
	let state: RuntimeShellState = { ...initialRuntimeState(), sessionId: "session", sessionGeneration: 1 };
	state = reduceRuntimeEvent(state, "status.changed", { session_id: "session", generation: 1, goal, turn_running: false });
	assert.deepEqual(projectRuntimeState(state).footer.goal, goal);
	const stale = reduceRuntimeEvent(state, "status.changed", { session_id: "other", generation: 1, goal: null });
	assert.deepEqual(projectRuntimeState(stale).footer.goal, goal);
	const changed = reduceRuntimeEvent(state, "session.changed", { session_id: "other", generation: 2 });
	assert.equal(projectRuntimeState(changed).footer.goal, null);
});

test("automatic turns create one system marker and never a human message", () => {
	const params = { session_id: "session", generation: 1, client_turn_id: "goal-client", turn_id: "goal-turn", source: "goal" };
	let state: RuntimeShellState = { ...initialRuntimeState(), sessionId: "session", sessionGeneration: 1 };
	state = reduceRuntimeEvent(state, "turn.started", params);
	state = reduceRuntimeEvent(state, "turn.started", params);
	assert.equal(state.transcript.length, 1);
	assert.equal(state.transcript[0]?.type, "system_notice");
	assert.equal(state.transcript[0]?.id, "goal-turn:goal");
	assert.equal(state.transcript[0]?.text, "Continuing goal");
	assert.equal(state.turnRunning, true);
});

test("goal status keeps text labels and fits narrow terminals", () => {
	for (const status of ["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"] as const) {
		const line = renderGoalStatus({ ...goal, status }, 100);
		assert.match(line, new RegExp(`Goal ${status.replaceAll("_", " ")}`));
		assert.match(line, /1250\/50000/);
		for (const width of [1, 8, 20, 40, 80]) assert.ok(visibleWidth(renderGoalStatus({ ...goal, status }, width)) <= width);
	}
});
