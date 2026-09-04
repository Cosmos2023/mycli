import assert from "node:assert/strict";
import test from "node:test";
import { AgentBudgetTracker } from "../src/agent-budget-tracker.ts";

test("agent budget tracker owns provider and tool reservations", () => {
	const tracker = new AgentBudgetTracker({
		budget: { maxTurns: 2, maxToolCalls: 3 },
	});

	assert.equal(tracker.beginProviderStep(), undefined);
	assert.equal(tracker.beginProviderStep(), undefined);
	assert.equal(tracker.providerStepCount(), 2);
	assert.equal(tracker.beginProviderStep(), "max_turns");
	assert.equal(tracker.exhaustion(), "max_turns");

	const tools = new AgentBudgetTracker({ budget: { maxToolCalls: 3 } });
	assert.equal(tools.reserveToolCalls(2), undefined);
	assert.equal(tools.toolCallCount(), 2);
	assert.equal(tools.reserveToolCalls(2), "max_tool_calls");
	assert.equal(tools.toolCallCount(), 2);
});

test("agent budget tracker owns token and no-progress transitions", () => {
	const tokens = new AgentBudgetTracker({ budget: { maxTokens: 10 } });
	assert.deepEqual(tokens.observeProviderOutput({
		usage: { total_tokens: 10 },
		assistantText: "",
		toolCallCount: 1,
	}), { retryEmptyOutput: false, exhaustion: "max_tokens" });

	const noProgress = new AgentBudgetTracker({ budget: { noProgressTurnLimit: 2 } });
	assert.deepEqual(noProgress.observeProviderOutput({
		usage: {},
		assistantText: "",
		toolCallCount: 0,
	}), { retryEmptyOutput: true });
	assert.deepEqual(noProgress.observeProviderOutput({
		usage: {},
		assistantText: "",
		toolCallCount: 0,
	}), { retryEmptyOutput: false, exhaustion: "no_progress" });

	const ordinaryBlank = new AgentBudgetTracker();
	assert.deepEqual(ordinaryBlank.observeProviderOutput({
		usage: {},
		assistantText: "",
		toolCallCount: 0,
	}), { retryEmptyOutput: false });
});

test("agent budget tracker uses one monotonic wall-clock owner", () => {
	let now = 100;
	const tracker = new AgentBudgetTracker({
		budget: { wallClockMs: 50 },
		clock: () => now,
	});

	now = 149;
	assert.equal(tracker.wallClockExhaustion(), undefined);
	now = 150;
	assert.equal(tracker.wallClockExhaustion(), "wall_clock");
	assert.equal(tracker.markExhausted("max_turns"), "wall_clock");
});

test("agent budget tracker rejects malformed limits and reservations", () => {
	assert.throws(
		() => new AgentBudgetTracker({ budget: { maxTurns: 0 } }),
		/positive integer/u,
	);
	const tracker = new AgentBudgetTracker();
	assert.throws(() => tracker.reserveToolCalls(-1), /non-negative integer/u);
});
