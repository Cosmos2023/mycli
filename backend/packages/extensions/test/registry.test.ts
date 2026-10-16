import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionRegistry, type ExtensionFailure } from "../src/index.ts";

const turn = {
	sessionId: "session-1",
	turnId: "turn-1",
	workspaceRoot: "/workspace",
	source: "user" as const,
	message: "hello",
	signal: new AbortController().signal,
};

test("extensions run in registration order for every hook", async () => {
	const order: string[] = [];
	const registry = new ExtensionRegistry();
	registry.register({
		id: "second",
		turnLifecycle: {
			onTurnStart: () => { order.push("second:start"); },
			onTurnComplete: () => { order.push("second:complete"); },
		},
		tokenUsage: { onTokenUsage: () => { order.push("second:usage"); } },
	});
	registry.register({
		id: "first",
		turnLifecycle: { onTurnStart: () => { order.push("first:start"); } },
		tokenUsage: { onTokenUsage: () => { order.push("first:usage"); } },
	});

	await registry.runTurnStart(turn);
	await registry.runTurnComplete({ ...turn, assistantText: "done", usage: {}, terminalSnapshotWritten: true });
	await registry.runTokenUsage({ sessionId: "session-1", turnId: "turn-1", requestId: "request-1", usage: {}, phase: "final" });

	assert.deepEqual(order, [
		"second:start",
		"first:start",
		"second:complete",
		"second:usage",
		"first:usage",
	]);
	assert.deepEqual(registry.ids(), ["second", "first"]);
	assert.equal(registry.has("first"), true);
	assert.equal(registry.has("missing"), false);
});

test("a throwing extension is isolated, reported, and never stops the others", async () => {
	const failures: ExtensionFailure[] = [];
	const registry = new ExtensionRegistry({ onFailure: (failure) => failures.push(failure) });
	const ran: string[] = [];
	registry.register({
		id: "broken",
		turnLifecycle: {
			onTurnStart: () => { throw new Error("private payload \u0000 boom"); },
			onTurnComplete: () => { throw new Error("complete failed"); },
		},
		conversationItems: { conversationItems: () => { throw new Error("items failed"); } },
		tokenUsage: { onTokenUsage: () => { throw new Error("usage failed"); } },
	});
	registry.register({
		id: "healthy",
		turnLifecycle: { onTurnStart: () => { ran.push("healthy"); } },
	});

	await registry.runTurnStart(turn);
	await registry.runTurnComplete({ ...turn, assistantText: "done", usage: {}, terminalSnapshotWritten: true });
	await registry.runTokenUsage({ sessionId: "session-1", turnId: "turn-1", requestId: "request-1", usage: {}, phase: "final" });
	const items = await registry.collectConversationItems(turn);

	assert.deepEqual(ran, ["healthy"]);
	assert.deepEqual(items, []);
	assert.deepEqual(failures, [
		{ extensionId: "broken", hook: "onTurnStart", message: "private payload   boom" },
		{ extensionId: "broken", hook: "onTurnComplete", message: "complete failed" },
		{ extensionId: "broken", hook: "onTokenUsage", message: "usage failed" },
		{ extensionId: "broken", hook: "conversationItems", message: "items failed" },
	]);
});

test("conversation items from every extension are concatenated in order", async () => {
	const registry = new ExtensionRegistry();
	registry.register({
		id: "first",
		conversationItems: {
			conversationItems: () => [{ type: "user" as const, text: "first memory" }],
		},
	});
	registry.register({ id: "empty", conversationItems: { conversationItems: () => undefined } });
	registry.register({
		id: "second",
		conversationItems: {
			conversationItems: async () => [{ type: "user" as const, text: "second memory" }],
		},
	});

	const items = await registry.collectConversationItems(turn);

	assert.deepEqual(items.map((item) => item.type === "user" ? item.text : item.type), [
		"first memory",
		"second memory",
	]);
});

test("duplicate and empty extension ids are rejected", () => {
	const registry = new ExtensionRegistry();
	registry.register({ id: "goal" });

	assert.throws(() => registry.register({ id: "goal" }), /duplicate extension id/u);
	assert.throws(() => registry.register({ id: "   " }), /must be non-empty/u);
});

test("a failure reporter that throws cannot break the hook chain", async () => {
	const registry = new ExtensionRegistry({
		onFailure: () => { throw new Error("reporter failed"); },
	});
	const ran: string[] = [];
	registry.register({ id: "broken", turnLifecycle: { onTurnStart: () => { throw new Error("boom"); } } });
	registry.register({ id: "healthy", turnLifecycle: { onTurnStart: () => { ran.push("healthy"); } } });

	await registry.runTurnStart(turn);

	assert.deepEqual(ran, ["healthy"]);
});

test("the first extension that wants a turn gets it, and a throwing one is skipped", () => {
	const failures: ExtensionFailure[] = [];
	const registry = new ExtensionRegistry({ onFailure: (failure) => failures.push(failure) });
	const reference = { goalId: "goal-1", revision: 2 };
	registry.register({ id: "quiet", admission: { nextTurn: () => undefined } });
	registry.register({ id: "broken", admission: { nextTurn: () => { throw new Error("boom"); } } });
	registry.register({
		id: "goal",
		admission: {
			nextTurn: () => ({ source: "goal", message: "continue", reference }),
		},
	});
	registry.register({
		id: "later",
		admission: { nextTurn: () => ({ source: "goal", message: "later" }) },
	});

	const admission = registry.nextTurn({ sessionId: "session-1", workspaceRoot: "/workspace", toolNames: ["Shell"] });

	assert.deepEqual(admission, { extensionId: "goal", source: "goal", message: "continue", reference });
	assert.deepEqual(failures, [{ extensionId: "broken", hook: "nextTurn", message: "boom" }]);
	assert.equal(registry.nextTurn({ sessionId: "s", workspaceRoot: "/w", toolNames: [] })?.extensionId, "goal");
});

test("admission validation is reported and still rejects the turn", () => {
	const failures: ExtensionFailure[] = [];
	const registry = new ExtensionRegistry({ onFailure: (failure) => failures.push(failure) });
	registry.register({
		id: "goal",
		admission: {
			assertAdmission: ({ reference }) => {
				if (reference !== "ok") throw new Error("stale goal");
			},
			onAdmissionFailed: () => undefined,
		},
	});

	assert.doesNotThrow(() => registry.assertAdmission({ extensionId: "goal", reference: "ok" }, { sessionId: "s" }));
	assert.throws(() => registry.assertAdmission({ extensionId: "goal", reference: "stale" }, { sessionId: "s" }), /stale goal/u);
	assert.throws(() => registry.assertAdmission({ extensionId: "missing" }, { sessionId: "s" }), /unregistered extension/u);
	assert.deepEqual(failures, [{ extensionId: "goal", hook: "assertAdmission", message: "stale goal" }]);
});

test("turn lifecycle reports admission and terminal state to every extension", async () => {
	const seen: string[] = [];
	const registry = new ExtensionRegistry();
	registry.register({
		id: "goal",
		turnLifecycle: {
			onTurnAdmitted: (input) => { seen.push(`admitted:${input.source}:${input.turnId}`); },
			onTurnFinished: (input) => { seen.push(`finished:${input.status}:${input.errorCode ?? "none"}`); },
		},
	});
	registry.register({
		id: "audit",
		turnLifecycle: { onTurnFinished: (input) => { seen.push(`audit:${input.turnId}`); } },
	});

	await registry.runTurnAdmitted({
		sessionId: "session-1",
		turnId: "turn-1",
		source: "goal",
		admission: { extensionId: "goal", reference: 1 },
	});
	await registry.runTurnFinished({ sessionId: "session-1", turnId: "turn-1", source: "goal", status: "failed", errorCode: "quota_exceeded" });

	assert.deepEqual(seen, ["admitted:goal:turn-1", "finished:failed:quota_exceeded", "audit:turn-1"]);
});

test("the first extension with a stop reason wins and a throwing one is skipped", () => {
	const failures: ExtensionFailure[] = [];
	const registry = new ExtensionRegistry({ onFailure: (failure) => failures.push(failure) });
	registry.register({ id: "quiet", turnPolicy: { stopReason: () => undefined } });
	registry.register({ id: "broken", turnPolicy: { stopReason: () => { throw new Error("boom"); } } });
	registry.register({
		id: "budget",
		turnPolicy: {
			stopReason: () => ({ message: "Goal token budget exhausted.", interruptionReason: "goal_budget" }),
		},
	});
	registry.register({ id: "later", turnPolicy: { stopReason: () => ({ message: "later" }) } });

	const input = { sessionId: "session-1", turnId: "turn-1" };
	assert.deepEqual(registry.stopReason(input), {
		extensionId: "budget",
		message: "Goal token budget exhausted.",
		interruptionReason: "goal_budget",
	});
	assert.deepEqual(failures, [{ extensionId: "broken", hook: "stopReason", message: "boom" }]);
	assert.equal(registry.toolsStopReason(input), undefined);
	assert.equal(registry.allowTools(input), true);
});

test("every extension is asked about tools so one refusal strips them", () => {
	const asked: string[] = [];
	const registry = new ExtensionRegistry();
	registry.register({ id: "wrap-up", turnPolicy: { allowTools: () => { asked.push("wrap-up"); return false; } } });
	registry.register({ id: "audit", turnPolicy: { allowTools: () => { asked.push("audit"); return true; } } });
	registry.register({ id: "broken", turnPolicy: { allowTools: () => { throw new Error("boom"); } } });

	assert.equal(registry.allowTools({ sessionId: "session-1", turnId: "turn-1" }), false);
	assert.deepEqual(asked, ["wrap-up", "audit"]);
});
