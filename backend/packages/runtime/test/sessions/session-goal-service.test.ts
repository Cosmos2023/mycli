import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { goalReference, goalUsageTokens } from "@mycli/core";
import { openRuntimeSessionStore } from "@mycli/storage";
import { SessionGoalService } from "../../src/sessions/session-goal-service.ts";
import { SessionGoalUsageTracker } from "../../src/sessions/session-goal-usage.ts";

function fixture(t: { after(fn: () => void): void }): {
	service: SessionGoalService; store: ReturnType<typeof openRuntimeSessionStore>; advance(ms: number): void;
} {
	const directory = mkdtempSync(join(tmpdir(), "mycli-goal-test-"));
	const store = openRuntimeSessionStore({ dbPath: join(directory, "sessions.db") });
	let now = 0;
	const service = new SessionGoalService({ store: store.goals, sessionId: "session", workspaceRoot: directory, threadId: "session", monotonicClock: () => now });
	t.after(() => { service.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
	return { service, store, advance: (ms) => { now += ms; } };
}

test("normalizes protocol cache shapes and reports unavailable usage", () => {
	assert.equal(goalUsageTokens({ input_tokens: 100, cached_tokens: 60, output_tokens: 10 }), 50);
	assert.equal(goalUsageTokens({ input_tokens: 30, cache_creation_input_tokens: 10, cache_read_input_tokens: 60, output_tokens: 10 }), 50);
	assert.equal(goalUsageTokens({ total_tokens: 110 }), null);
});

test("durable goal-only sessions survive and observations are idempotent", (t) => {
	const { service, store, advance } = fixture(t);
	service.create({ objective: "Finish the migration", tokenBudget: 100 });
	assert.ok(store.loadSession("session"));
	service.beginTurn("turn", "goal", service.continuation());
	assert.equal(service.continuation(), undefined);
	service.observeUsage("turn", "request", { input_tokens: 50, cached_tokens: 20, output_tokens: 10 });
	service.observeUsage("turn", "request", { input_tokens: 50, cached_tokens: 20, output_tokens: 10 });
	advance(1234);
	service.finishTurn("turn", "completed");
	assert.equal(service.get()?.tokens_used, 40);
	assert.equal(service.get()?.elapsed_ms, 1234);
	assert.equal(service.get()?.rounds_started, 1);
	assert.ok(service.continuation());
	assert.equal(store.loadConversationItems("session").length, 0);
	assert.equal(store.loadReadableTranscript("session").length, 0);
});

test("creation midway through a human turn has a fresh accounting baseline", (t) => {
	const { service } = fixture(t);
	service.beginTurn("turn", "user");
	service.observeUsage("turn", "before", { input_tokens: 100, output_tokens: 10 });
	service.create({ objective: "Finish" }, "turn");
	service.observeUsage("turn", "after", { input_tokens: 30, output_tokens: 10 });
	assert.equal(service.get()?.audit_turns, 1);
	assert.equal(service.get()?.tokens_used, 40);
	service.finishTurn("turn", "completed");
});

test("pause fences automatic admission and late tools but accounts in-flight usage", (t) => {
	const { service } = fixture(t);
	service.create({ objective: "Finish" });
	const ref = service.continuation()!;
	service.beginTurn("turn", "goal", ref);
	service.interrupt();
	assert.throws(() => service.assertContinuation(ref), /changed/);
	assert.throws(() => service.updateFromTool("complete", "turn"), /changed/);
	service.observeUsage("turn", "late", { input_tokens: 10, output_tokens: 2 });
	service.finishTurn("turn", "completed");
	assert.equal(service.get()?.tokens_used, 12);
	assert.equal(service.get()?.status, "paused");
	assert.equal(service.continuation(), undefined);
});

test("clear/replacement cannot be modified or charged by old callbacks", (t) => {
	const { service } = fixture(t);
	service.beginTurn("turn", "user");
	const old = service.create({ objective: "Old" }, "turn");
	service.clear();
	service.create({ objective: "New" });
	assert.throws(() => service.create({ objective: "stale" }, "turn"), /changed/);
	assert.throws(() => service.updateFromTool("complete", "turn"), /changed/);
	service.observeAttributedUsage(old.goal_id, "late-child", { input_tokens: 10, output_tokens: 2 });
	service.finishTurn("turn", "failed");
	assert.equal(service.get()?.tokens_used, 0);
	assert.equal(service.get()?.status, "active");
});

test("blocked audit restarts after resume and completion remains terminal", (t) => {
	const { service } = fixture(t);
	service.create({ objective: "Finish" });
	for (const turn of ["one", "two"]) {
		service.beginTurn(turn, "goal", service.continuation());
		assert.throws(() => service.updateFromTool("blocked", turn), /three/);
		service.finishTurn(turn, "completed");
	}
	service.beginTurn("three", "goal", service.continuation());
	service.updateFromTool("blocked", "three");
	service.finishTurn("three", "completed");
	service.setStatus("active");
	service.beginTurn("resumed", "goal", service.continuation());
	assert.throws(() => service.updateFromTool("blocked", "resumed"), /three/);
	service.updateFromTool("complete", "resumed");
	service.finishTurn("resumed", "completed");
	assert.throws(() => service.setStatus("active"), /complete/);
	assert.equal(service.continuation(), undefined);
});

test("budget stops at observations and unknown usage is not silently free", (t) => {
	const { service } = fixture(t);
	service.create({ objective: "Finish", tokenBudget: 10 });
	service.beginTurn("turn", "goal", service.continuation());
	service.observeUsage("turn", "large", { input_tokens: 10, output_tokens: 5 });
	assert.equal(service.get()?.status, "budget_limited");
	assert.equal(service.get()?.tokens_used, 15);
	service.finishTurn("turn", "completed");
	assert.throws(() => service.setStatus("active"), /budget/);
	service.edit({ tokenBudget: 100 }); service.setStatus("active");
	service.beginTurn("unknown", "goal", service.continuation());
	service.observeUsage("unknown", "missing", {});
	assert.equal(service.get()?.usage_incomplete, true);
	assert.equal(service.get()?.status, "budget_limited");
	service.finishTurn("unknown", "completed");
});

test("compaction budget keeps final response authority while fencing stale or paused goals", (t) => {
	const { service } = fixture(t);
	const id = service.create({ objective: "Finish", tokenBudget: 100 }).goal_id;
	assert.equal(service.remainingTokenBudget(id), 100);
	service.beginTurn("turn", "user");
	service.observeAttributedUsage(id, "summary:1", { input_tokens: 20, output_tokens: 10 });
	assert.equal(service.remainingTokenBudget(id), 70);
	service.updateFromTool("complete", "turn");
	assert.equal(service.remainingTokenBudget(id), 0);
	assert.equal(service.remainingTokenBudget(id, "turn"), 70);
	assert.equal(service.remainingTokenBudget("old", "turn"), 0);
	service.finishTurn("turn", "completed");
	assert.equal(service.remainingTokenBudget(id, "turn"), 0);
	service.clear();
	const next = service.create({ objective: "Continue" }).goal_id;
	assert.equal(service.remainingTokenBudget(next), undefined);
	service.setStatus("paused");
	assert.equal(service.remainingTokenBudget(next), 0);
});

test("restore excludes downtime and requires explicit resume; listeners cannot undo commits", (t) => {
	const { service, advance } = fixture(t);
	service.subscribe(() => { throw new Error("disconnected"); });
	service.create({ objective: "Finish" });
	advance(500000);
	service.restore();
	assert.equal(service.get()?.status, "paused");
	assert.equal(service.get()?.elapsed_ms, 0);
	assert.equal(service.continuation(), undefined);
	const resumed = service.setStatus("active");
	assert.deepEqual(service.continuation(), goalReference(resumed));
});

test("cumulative attempt checkpoints survive service replacement without double charging", (t) => {
	const { service, store } = fixture(t);
	const goal = service.create({ objective: "Finish" });
	service.observeAttributedUsage(goal.goal_id, "attempt-1", { input_tokens: 20, output_tokens: 2 });
	service.observeAttributedUsage(goal.goal_id, "attempt-1", { input_tokens: 20, output_tokens: 8 });
	service.observeAttributedUsage(goal.goal_id, "attempt-1", { input_tokens: 20, output_tokens: 4 });
	assert.equal(service.get()?.tokens_used, 28);
	const reloaded = new SessionGoalService({ sessionId: "session", workspaceRoot: "/workspace", threadId: "session", store: store.goals });
	reloaded.restore();
	reloaded.observeAttributedUsage(goal.goal_id, "attempt-1", { input_tokens: 20, output_tokens: 8 });
	reloaded.observeAttributedUsage(goal.goal_id, "attempt-2", { input_tokens: 10, output_tokens: 2 });
	assert.equal(reloaded.get()?.tokens_used, 40);
	reloaded.close();
});

test("failure and quota stop immediately without exhausting the semantic blocker audit", (t) => {
	const { service } = fixture(t);
	service.create({ objective: "Finish" });
	service.beginTurn("one", "goal", service.continuation());
	service.finishTurn("one", "failed", "quota_exceeded");
	assert.equal(service.get()?.status, "usage_limited");
	service.setStatus("active");
	service.beginTurn("two", "goal", service.continuation());
	service.finishTurn("two", "failed", "provider_error");
	assert.equal(service.get()?.status, "blocked");
	assert.equal(service.continuation(), undefined);
});

test("goal audit and usage writes roll back together when persistence fails", (t) => {
	const { service, store } = fixture(t);
	const goal = service.create({ objective: "Finish" });
	const before = store.goals.get("session");
	assert.throws(() => store.goals.commit({ sessionId: "session", workspaceRoot: "/workspace", threadId: "session",
		eventId: "x".repeat(600), operation: "usage", expected: before, next: { ...goal, tokens_used: 10 },
		usage: { requestId: "attempt", tokens: 10 }, createdAt: new Date().toISOString() }));
	assert.deepEqual(store.goals.get("session"), before);
	assert.equal(store.goals.usage("session", goal.goal_id, "attempt"), undefined);
});

test("forks retain inspectable goals, including goal-only sessions, without arming them", (t) => {
	const { service, store } = fixture(t);
	const original = service.create({ objective: "Finish" });
	store.forkSession({ sourceSessionId: "session", targetSessionId: "fork" });
	const forked = store.goals.get("fork")!;
	assert.equal(forked.status, "paused");
	assert.equal(forked.objective, original.objective);
	assert.notEqual(forked.goal_id, original.goal_id);
	assert.equal(service.get()?.status, "active");
	const state = new SessionGoalService({ sessionId: "fork", workspaceRoot: "/workspace", threadId: "fork", store: store.goals });
	state.restore();
	assert.equal(state.continuation(), undefined);
	state.close();
});

test("delegated usage retains its goal across parent settlement, reuse, and nested work", (t) => {
	const { service } = fixture(t);
	const root = new SessionGoalUsageTracker(service);
	const child = new SessionGoalUsageTracker();
	const grandchild = new SessionGoalUsageTracker();
	service.create({ objective: "First goal" });
	service.beginTurn("first-parent", "goal", service.continuation());
	child.bind("first-child", root.capture("first-parent"));
	grandchild.bind("grandchild", child.capture("first-child"));
	service.finishTurn("first-parent", "completed");
	assert.deepEqual(root.capture("first-parent")?.ref, child.capture("first-child")?.ref);
	child.bind("deferred-child", root.capture("first-parent"));
	grandchild.observe("grandchild", "nested", { input_tokens: 10, output_tokens: 2 });
	assert.equal(service.get()?.tokens_used, 12);
	service.interrupt();
	assert.match(child.stopReason("first-child")!, /changed/);
	child.observe("first-child", "in-flight", { input_tokens: 10, output_tokens: 2 });
	assert.equal(service.get()?.tokens_used, 24);
	service.clear(); service.create({ objective: "Second goal", tokenBudget: 20 });
	assert.equal(root.capture("first-parent"), undefined);
	service.beginTurn("second-parent", "goal", service.continuation());
	child.bind("second-child", root.capture("second-parent"));
	grandchild.observe("grandchild", "old-late", { input_tokens: 100, output_tokens: 20 });
	child.observe("first-child", "old-late-2", { input_tokens: 100, output_tokens: 20 });
	assert.equal(service.get()?.tokens_used, 0);
	child.observe("second-child", "current", { input_tokens: 20, output_tokens: 2 });
	assert.equal(service.get()?.tokens_used, 22);
	assert.match(child.stopReason("second-child")!, /budget/);
	child.release("second-child");
	assert.equal(child.capture("second-child"), undefined);
	service.finishTurn("second-parent", "completed");
});

test("historical forks retain the goal at the selected completed turn", (t) => {
	const { service, store } = fixture(t);
	const now = new Date().toISOString();
	const original = service.create({ objective: "Original objective" });
	store.reserveTurn({ sessionId: "session", clientTurnId: "client", clientUserMessageId: "user", turnId: "turn",
		requestFingerprint: `sha256:${"a".repeat(64)}`, workspaceRoot: store.loadSession("session")!.workspaceRoot,
		threadId: "session", userText: "First request", startedAt: now });
	store.completeTurn({ sessionId: "session", clientTurnId: "client", assistantText: "First answer", usage: {}, completedAt: now });
	const boundary = store.loadTurnEventWindow("session", "turn", { limit: 100 }).events
		.find((event) => event.eventType === "turn_lifecycle" && event.payload.phase === "completed")!;
	service.clear(); service.create({ objective: "Later objective" });
	store.forkSession({ sourceSessionId: "session", targetSessionId: "historical", forkEventId: boundary.eventId });
	const historical = store.goals.get("historical")!;
	assert.equal(historical.objective, original.objective);
	assert.equal(historical.status, "paused");
	assert.notEqual(historical.goal_id, original.goal_id);
	store.forkSession({ sourceSessionId: "session", targetSessionId: "current" });
	assert.equal(store.goals.get("current")?.objective, "Later objective");
	store.forkSession({ sourceSessionId: "historical", targetSessionId: "nested", forkEventId: boundary.eventId });
	assert.equal(store.goals.get("nested")?.objective, original.objective);
});
