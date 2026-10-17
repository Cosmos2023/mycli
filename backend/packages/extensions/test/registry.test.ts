import assert from "node:assert/strict";
import test from "node:test";
import type { ToolAdapter } from "@mycli/tools";
import { ExtensionRegistry, type ExtensionFailure } from "../src/index.ts";

function toolAdapter(name: string): ToolAdapter {
	return {
		definition: { id: name, name, description: name, inputSchema: { type: "object" } },
		execute: async () => ({ success: true, modelOutput: name, summary: name, metadata: {} }),
	};
}

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

test("session lifecycle reports and propagates restore and interrupt", () => {
	const failures: ExtensionFailure[] = [];
	const seen: string[] = [];
	const registry = new ExtensionRegistry({ onFailure: (failure) => failures.push(failure) });
	registry.register({
		id: "goal",
		sessionLifecycle: {
			onRestore: () => { seen.push("restore"); throw new Error("restore failed"); },
			onInterrupt: () => { seen.push("interrupt"); },
		},
	});
	registry.register({ id: "audit", sessionLifecycle: { onInterrupt: () => { seen.push("audit"); } } });

	assert.throws(() => registry.restore(), /restore failed/u);
	assert.deepEqual(failures, [{ extensionId: "goal", hook: "onRestore", message: "restore failed" }]);
	registry.interrupt();
	assert.deepEqual(seen, ["restore", "interrupt", "audit"]);
});

test("closing runs every extension and rethrows the first failure", () => {
	const failures: ExtensionFailure[] = [];
	const closed: string[] = [];
	const registry = new ExtensionRegistry({ onFailure: (failure) => failures.push(failure) });
	registry.register({
		id: "broken",
		sessionLifecycle: { onClose: () => { closed.push("broken"); throw new Error("close failed"); } },
	});
	registry.register({ id: "healthy", sessionLifecycle: { onClose: () => { closed.push("healthy"); } } });

	assert.throws(() => registry.close(), /close failed/u);
	assert.deepEqual(closed, ["broken", "healthy"]);
	assert.deepEqual(failures, [{ extensionId: "broken", hook: "onClose", message: "close failed" }]);
});

test("tool contributions are concatenated in order and a throwing one is skipped", () => {
	const failures: ExtensionFailure[] = [];
	const registry = new ExtensionRegistry({ onFailure: (failure) => failures.push(failure) });
	registry.register({ id: "first", tools: { tools: () => [toolAdapter("create_goal")] } });
	registry.register({ id: "broken", tools: { tools: () => { throw new Error("boom"); } } });
	registry.register({ id: "second", tools: { tools: () => [toolAdapter("update_goal")] } });

	assert.deepEqual(registry.tools().map((adapter) => adapter.definition.name), ["create_goal", "update_goal"]);
	assert.deepEqual(failures, [{ extensionId: "broken", hook: "tools", message: "boom" }]);
});

test("tool registrations carry catalog metadata and a throwing one is skipped", () => {
	const failures: ExtensionFailure[] = [];
	const registry = new ExtensionRegistry({ onFailure: (failure) => failures.push(failure) });
	registry.register({
		id: "mcp",
		tools: {
			toolRegistrations: () => [{
				id: "mcp:server:search",
				source: "mcp",
				definition: { id: "mcp:search", name: "search", description: "Search", inputSchema: {} },
				adapter: toolAdapter("search"),
				originMetadata: { server: "server", tool: "search" },
				modelVisible: false,
			}],
		},
	});
	registry.register({ id: "broken", tools: { toolRegistrations: () => { throw new Error("boom"); } } });

	assert.deepEqual(registry.toolRegistrations().map((registration) => ({
		id: registration.id,
		source: registration.source,
		name: registration.definition.name,
		modelVisible: registration.modelVisible,
	})), [{ id: "mcp:server:search", source: "mcp", name: "search", modelVisible: false }]);
	assert.deepEqual(failures, [{ extensionId: "broken", hook: "toolRegistrations", message: "boom" }]);
});

test("the first extension with a skill catalog and selected instructions wins", () => {
	const failures: ExtensionFailure[] = [];
	const registry = new ExtensionRegistry({ onFailure: (failure) => failures.push(failure) });
	registry.register({ id: "quiet", skills: { skillCatalog: () => "  ", selectedInstructions: () => [] } });
	registry.register({
		id: "skills",
		skills: {
			skillCatalog: () => "  - review: Review a change  ",
			selectedInstructions: ({ turnId }) => turnId === "turn-1"
				? [{ skillId: "review", content: "Read the diff." }]
				: undefined,
		},
	});
	registry.register({ id: "later", skills: { skillCatalog: () => "later" } });

	assert.equal(registry.skillCatalog(), "- review: Review a change");
	assert.deepEqual(registry.selectedSkillInstructions({ sessionId: "session-1", turnId: "turn-1" }), [
		{ skillId: "review", content: "Read the diff." },
	]);
	assert.equal(registry.selectedSkillInstructions({ sessionId: "session-1", turnId: "turn-2" }), undefined);
	assert.deepEqual(failures, []);
});

test("a skill catalog that cannot be rendered fails the session instead of disappearing", () => {
	const failures: ExtensionFailure[] = [];
	const registry = new ExtensionRegistry({ onFailure: (failure) => failures.push(failure) });
	registry.register({ id: "skills", skills: { skillCatalog: () => { throw new Error("boom"); } } });
	registry.register({
		id: "broken",
		skills: { selectedInstructions: () => { throw new Error("selected skill is unavailable"); } },
	});

	assert.throws(() => registry.skillCatalog(), /boom/u);
	assert.throws(
		() => registry.selectedSkillInstructions({ sessionId: "session-1", turnId: "turn-1" }),
		/selected skill is unavailable/u,
	);
	assert.deepEqual(failures, [
		{ extensionId: "skills", hook: "skillCatalog", message: "boom" },
		{ extensionId: "broken", hook: "selectedInstructions", message: "selected skill is unavailable" },
	]);
});

test("the first extension with a compaction budget wins and a throwing one is skipped", () => {
	const failures: ExtensionFailure[] = [];
	const charged: string[] = [];
	const registry = new ExtensionRegistry({ onFailure: (failure) => failures.push(failure) });
	registry.register({ id: "quiet", compactionBudget: { compactionBudget: () => undefined } });
	registry.register({ id: "broken", compactionBudget: { compactionBudget: () => { throw new Error("boom"); } } });
	registry.register({
		id: "goal",
		compactionBudget: {
			compactionBudget: ({ turnId }) => ({
				remainingTokenBudget: () => (turnId === "turn-1" ? 40 : undefined),
				observeUsage: (requestId, usage) => { charged.push(`${requestId}:${usage.output_tokens}`); },
			}),
		},
	});

	const budget = registry.compactionBudget({ sessionId: "session-1", turnId: "turn-1" });
	assert.equal(budget?.remainingTokenBudget(), 40);
	budget?.observeUsage("compaction:op:1", { output_tokens: 7 });
	assert.deepEqual(charged, ["compaction:op:1:7"]);
	assert.deepEqual(failures, [{ extensionId: "broken", hook: "compactionBudget", message: "boom" }]);
	assert.equal(registry.compactionBudget({ sessionId: "session-1" })?.remainingTokenBudget(), undefined);
});

test("the first extension with conversation context wins and a throwing one is skipped", () => {
	const failures: ExtensionFailure[] = [];
	const registry = new ExtensionRegistry({ onFailure: (failure) => failures.push(failure) });
	registry.register({ id: "blank", conversationContext: { conversationContext: () => "   " } });
	registry.register({ id: "broken", conversationContext: { conversationContext: () => { throw new Error("boom"); } } });
	registry.register({ id: "goal", conversationContext: { conversationContext: () => "  active goal  " } });
	registry.register({ id: "later", conversationContext: { conversationContext: () => "later" } });

	assert.equal(registry.conversationContext({ sessionId: "session-1", turnId: "turn-1" }), "active goal");
	assert.deepEqual(failures, [{ extensionId: "broken", hook: "conversationContext", message: "boom" }]);
	assert.equal(new ExtensionRegistry().conversationContext({ sessionId: "s", turnId: "t" }), undefined);
});

test("captured delegated work handles are offered to every extension that can adopt one", () => {
	const failures: ExtensionFailure[] = [];
	const registry = new ExtensionRegistry({ onFailure: (failure) => failures.push(failure) });
	const bound: string[] = [];
	const released: string[] = [];
	registry.register({
		id: "goal",
		delegation: { captureDelegatedWork: ({ turnId }) => (turnId === "parent-turn" ? { goalId: "goal-1" } : undefined) },
	});
	registry.register({
		id: "broken",
		delegation: { captureDelegatedWork: () => { throw new Error("boom"); } },
	});
	registry.register({
		id: "goal-usage",
		delegation: {
			bindDelegatedWork: ({ handle }) => { bound.push(JSON.stringify(handle)); },
			releaseDelegatedWork: ({ turnId }) => { released.push(turnId); },
		},
	});

	const handles = registry.captureDelegatedWork({ sessionId: "session-1", turnId: "parent-turn" });
	assert.deepEqual(handles, [{ goalId: "goal-1" }]);
	registry.bindDelegatedWork({ sessionId: "session-1", turnId: "child-turn", handles });
	registry.releaseDelegatedWork({ sessionId: "session-1", turnId: "child-turn" });

	assert.deepEqual(bound, ['{"goalId":"goal-1"}']);
	assert.deepEqual(released, ["child-turn"]);
	assert.deepEqual(failures, [{ extensionId: "broken", hook: "captureDelegatedWork", message: "boom" }]);
});

test("the first extension that recognises an error classifies it", () => {
	const failures: ExtensionFailure[] = [];
	const registry = new ExtensionRegistry({ onFailure: (failure) => failures.push(failure) });
	class FixtureFailure extends Error {}
	registry.register({ id: "quiet", failure: { normalizeFailure: () => undefined } });
	registry.register({ id: "broken", failure: { normalizeFailure: () => { throw new Error("boom"); } } });
	registry.register({
		id: "goal",
		failure: {
			normalizeFailure: ({ error }) => error instanceof FixtureFailure
				? { code: "interrupted", message: error.message, retryable: false }
				: undefined,
		},
	});

	assert.deepEqual(registry.normalizeFailure(new FixtureFailure("goal changed")), {
		code: "interrupted",
		message: "goal changed",
		retryable: false,
	});
	assert.deepEqual(failures, [{ extensionId: "broken", hook: "normalizeFailure", message: "boom" }]);
	assert.equal(new ExtensionRegistry().normalizeFailure(new Error("unowned")), undefined);
});
