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
	await registry.runTokenUsage({ sessionId: "session-1", turnId: "turn-1", requestId: "request-1", usage: {} });

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
	await registry.runTokenUsage({ sessionId: "session-1", turnId: "turn-1", requestId: "request-1", usage: {} });
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
