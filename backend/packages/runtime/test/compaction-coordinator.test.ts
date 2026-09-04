import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { CanonicalConversationItem } from "@mycli/core";
import type {
	ProviderEvent,
	ProviderRequest,
	ProviderRequestConfig,
} from "@mycli/core";
import type { ModelProvider } from "@mycli/providers";
import type { CommitCompactionInput, SaveStateInput } from "@mycli/storage";
import {
	CompactionCoordinator,
	type CompactionCoordinatorOptions,
	type CompactionRuntimeEvent,
} from "../src/compaction-coordinator.ts";
import { TokenCounter } from "../src/token-counter.ts";
import * as compactionModule from "../src/compaction-coordinator.ts";

test("summarizes through the provider abstraction with a bounded no-tool request", async () => {
	const requests: ProviderRequest[] = [];
	const provider: ModelProvider = {
		stream: (request) => {
			requests.push(request);
			return providerEvents([
				{ type: "reasoning_delta", text: "private reasoning" },
				{ type: "text_delta", text: "Compact " },
				{ type: "text_delta", text: "summary." },
				{ type: "completed", responseId: "summary-response" },
			]);
		},
	};
	const summarize = Reflect.get(compactionModule, "summarizeCompactionWithProvider") as
		| ((provider: ModelProvider, config: ProviderRequestConfig, input: {
			readonly items: readonly CanonicalConversationItem[];
			readonly instruction: string;
			readonly maxOutputTokens: number;
			readonly model?: string;
			readonly signal: AbortSignal;
		}) => Promise<string>)
		| undefined;
	assert.equal(typeof summarize, "function");
	const config: ProviderRequestConfig = {
		provider: "openai",
		protocol: "responses",
		model: "main-model",
		reasoningEffort: "high",
		sessionId: "session-1",
		cacheRetention: "short",
	};

	const summary = await summarize!(provider, config, {
		items: [{ type: "user", text: "old work" }],
		instruction: "Summarize only.",
		model: "summary-model",
		maxOutputTokens: 600,
		signal: new AbortController().signal,
	});

	assert.equal(summary, "Compact summary.");
	assert.equal(requests[0]?.model, "summary-model");
	assert.equal(requests[0]?.reasoningEffort, "none");
	assert.equal(requests[0]?.maxOutputTokens, 600);
	assert.equal(requests[0]?.sessionId, "session-1");
	assert.equal(requests[0]?.cacheRetention, "short");
	assert.deepEqual(requests[0]?.tools, []);
	assert.deepEqual(requests[0]?.items, [{ type: "user", text: "old work" }]);
});

test("rejects a tool call from the compaction summarizer", async () => {
	const summarize = Reflect.get(compactionModule, "summarizeCompactionWithProvider") as
		| ((provider: ModelProvider, config: ProviderRequestConfig, input: {
			readonly items: readonly CanonicalConversationItem[];
			readonly instruction: string;
			readonly maxOutputTokens: number;
			readonly signal: AbortSignal;
		}) => Promise<string>)
		| undefined;
	assert.equal(typeof summarize, "function");
	const provider: ModelProvider = {
		stream: () => providerEvents([
			{ type: "tool_call", callId: "call-1", name: "Read", argumentsJson: "{}" },
			{ type: "completed", responseId: "summary-response" },
		]),
	};

	await assert.rejects(
		() => summarize!(provider, providerConfig(), {
			items: [{ type: "user", text: "old work" }],
			instruction: "Summarize only.",
			maxOutputTokens: 600,
			signal: new AbortController().signal,
		}),
		/compaction summary provider returned a tool call/,
	);
});

test("keeps fresh input out of the summary and preserves raw history", async () => {
	const conversation = conversationFixture();
	const store = new FakeCompactionStore(conversation, historyFixture(conversation));
	let summaryInput: readonly CanonicalConversationItem[] = [];
	const events: CompactionRuntimeEvent[] = [];
	const coordinator = createCoordinator({
		store,
		summarize: async (input) => {
			summaryInput = input.items;
			return "Earlier work and decisions.";
		},
	});

	const result = await coordinator.compact({
		clientTurnId: "client-current",
		turnId: "turn-current",
		source: "pre_turn",
		conversation,
		freshItemIds: new Set(["current-user", "steer-q1"]),
		emit: events.push.bind(events),
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "compressed");
	assert.match(renderItems(summaryInput), /first request|first answer/u);
	assert.doesNotMatch(renderItems(summaryInput), /second request|second answer/u);
	assert.doesNotMatch(renderItems(summaryInput), /current request|fresh steer/);
	assert.equal(store.historyItems.length, conversation.length);
	assert.equal(store.commitInput?.checkpoint.status, "completed");
	assert.deepEqual(store.commitInput?.replacementItems, [
		{ type: "user", text: "[compact-summary]\nEarlier work and decisions." },
		{ type: "user", text: "second request " + "context ".repeat(20) },
		{ type: "assistant", text: "second answer " + "result ".repeat(20) },
		{ type: "user", text: "current request" },
		{ type: "user", text: "fresh steer" },
	]);
	assert.deepEqual(store.providerConversation.map((message) => message.content), [
		"[compact-summary]\nEarlier work and decisions.",
		"second request " + "context ".repeat(20),
		"second answer " + "result ".repeat(20),
		"current request",
		"fresh steer",
	]);
	assert.deepEqual(events.map((event) => event.type), [
		"compaction_started",
		"compaction_completed",
	]);
	assert.equal(events[1]?.type, "compaction_completed");
	if (events[1]?.type === "compaction_completed") {
		assert.equal(events[1].status, "compressed");
	}
	assert.equal(recordValue(store.savedStates[0]?.payload).status, "in_progress");
	assert.deepEqual(recordValue(store.savedStates[0]?.payload).replacement_messages, []);
});

test("compacts histories larger than the checkpoint replacement message limit", async () => {
	const priorTurns = Array.from({ length: 2_100 }, (_value, index) => [
		{ type: "user", text: `request ${index} ` + "history ".repeat(4) } as const,
		{ type: "assistant", text: `answer ${index} ` + "detail ".repeat(4) } as const,
	]).flat();
	const conversation: readonly CanonicalConversationItem[] = Object.freeze([
		...priorTurns,
		{ type: "user", text: "current request" },
	]);
	const history = historyFixture(
		conversation,
		conversation.map((_item, index) => index === conversation.length - 1
			? "current-user"
			: `history-${index}`),
	);
	const store = new FakeCompactionStore(conversation, history);

	const result = await createCoordinator({ store }).compact({
		clientTurnId: "client-current",
		turnId: "turn-current",
		source: "pre_turn",
		conversation,
		freshItemIds: new Set(["current-user"]),
		emit: () => {},
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "compressed");
	assert.deepEqual(recordValue(store.savedStates[0]?.payload).replacement_messages, []);
	assert.ok((store.commitInput?.replacementMessages.length ?? 0) < 4_096);
});

test("does not publish completion when replacement persistence fails", async () => {
	const conversation = conversationFixture();
	const store = new FakeCompactionStore(conversation, historyFixture(conversation));
	store.failCommit = true;
	const original = structuredClone(store.providerConversation);
	const events: CompactionRuntimeEvent[] = [];

	await assert.rejects(() => createCoordinator({ store }).compact({
		clientTurnId: "client-current",
		turnId: "turn-current",
		source: "pre_turn",
		conversation,
		freshItemIds: new Set(["current-user", "steer-q1"]),
		emit: events.push.bind(events),
		signal: new AbortController().signal,
	}));

	assert.deepEqual(events.map((event) => event.type), ["compaction_started"]);
	assert.deepEqual(store.providerConversation, original);
	assert.equal(store.state?.status, "in_progress");
});

test("keeps the old projection when summary generation fails", async () => {
	const conversation = conversationFixture();
	const store = new FakeCompactionStore(conversation, historyFixture(conversation));
	const events: CompactionRuntimeEvent[] = [];
	const result = await createCoordinator({
		store,
		summarize: async () => { throw new Error("private provider detail"); },
	}).compact({
		clientTurnId: "client-current",
		turnId: "turn-current",
		source: "pre_turn",
		conversation,
		freshItemIds: new Set(["current-user", "steer-q1"]),
		emit: events.push.bind(events),
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "failed");
	assert.deepEqual(result.providerConversation, conversation);
	assert.equal(store.commitInput, undefined);
	assert.equal(store.state, undefined);
	assert.deepEqual(events.map((event) => event.type), [
		"compaction_started",
		"compaction_completed",
	]);
	assert.equal(events[1]?.type, "compaction_completed");
	if (events[1]?.type === "compaction_completed") {
		assert.equal(events[1].status, "failed");
	}
});

test("classifies an interrupted summary request as interrupted", async () => {
	const conversation = conversationFixture();
	const store = new FakeCompactionStore(conversation, historyFixture(conversation));
	const controller = new AbortController();
	const events: CompactionRuntimeEvent[] = [];
	const result = await createCoordinator({
		store,
		summarize: async () => {
			controller.abort();
			const error = new Error("summary interrupted");
			error.name = "AbortError";
			throw error;
		},
	}).compact({
		clientTurnId: "client-current",
		turnId: "turn-current",
		source: "pre_turn",
		conversation,
		freshItemIds: new Set(["current-user", "steer-q1"]),
		emit: events.push.bind(events),
		signal: controller.signal,
	});

	assert.equal(result.status, "interrupted");
	assert.deepEqual(events.map((event) => event.type), [
		"compaction_started",
		"compaction_completed",
	]);
	assert.equal(events[1]?.type, "compaction_completed");
	if (events[1]?.type === "compaction_completed") {
		assert.equal(events[1].status, "failed");
		assert.equal(events[1].beforeTokens, events[1].afterTokens);
	}
});

test("does not resend a summary request after an in-progress restart", async () => {
	const conversation = conversationFixture();
	const store = new FakeCompactionStore(conversation, historyFixture(conversation));
	store.state = inProgressCheckpoint(conversation);
	let summaryCalls = 0;
	const coordinator = createCoordinator({
		store,
		summarize: async () => {
			summaryCalls += 1;
			return "must not be called";
		},
	});

	const result = await coordinator.compact({
		clientTurnId: "client-current",
		turnId: "turn-current",
		source: "pre_turn",
		conversation,
		freshItemIds: new Set(["current-user", "steer-q1"]),
		emit: () => {},
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "interrupted");
	assert.equal(summaryCalls, 0);
	assert.equal(store.state, undefined);
});

test("increments the persisted compaction window and records raw history size", async () => {
	const conversation = conversationFixture();
	const history = [
		{ id: "raw-before-projection", type: "user_message", text: "older raw item", metadata: {} },
		...historyFixture(conversation),
	];
	const store = new FakeCompactionStore(conversation, history);
	store.state = {
		...inProgressCheckpoint(conversation),
		status: "completed",
		window_number: 3,
	};

	const result = await createCoordinator({ store }).compact({
		clientTurnId: "client-current",
		turnId: "turn-current",
		source: "pre_turn",
		conversation,
		freshItemIds: new Set(["current-user", "steer-q1"]),
		emit: () => {},
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "compressed");
	assert.equal(store.savedStates[0]?.payload && recordValue(store.savedStates[0].payload).window_number, 4);
	assert.equal(store.commitInput?.checkpoint.window_number, 4);
	assert.equal(store.commitInput?.checkpoint.history_item_count, history.length);
});

test("skips below threshold and rejects summaries that save too little", async () => {
	const shortConversation: readonly CanonicalConversationItem[] = [
		{ type: "user", text: "short" },
		{ type: "assistant", text: "answer" },
		{ type: "user", text: "current" },
	];
	const shortStore = new FakeCompactionStore(
		shortConversation,
		historyFixture(shortConversation, ["old-user", "old-assistant", "current-user"]),
	);
	let calls = 0;
	const below = await createCoordinator({
		store: shortStore,
		tokenLimit: 1_000,
		summarize: async () => {
			calls += 1;
			return "unused";
		},
	}).compact({
		clientTurnId: "client-current",
		turnId: "turn-current",
		source: "pre_turn",
		conversation: shortConversation,
		freshItemIds: new Set(["current-user"]),
		emit: () => {},
		signal: new AbortController().signal,
	});
	assert.equal(below.status, "not_needed");
	assert.equal(calls, 0);

	const conversation = conversationFixture();
	const store = new FakeCompactionStore(conversation, historyFixture(conversation));
	const events: CompactionRuntimeEvent[] = [];
	const skipped = await createCoordinator({
		store,
		minSavingsRatio: 0.99,
		summarize: async () => "summary " + "still large ".repeat(50),
		summaryMaxTokens: 1_000,
	}).compact({
		clientTurnId: "client-current",
		turnId: "turn-current",
		source: "pre_turn",
		conversation,
		freshItemIds: new Set(["current-user", "steer-q1"]),
		emit: events.push.bind(events),
		signal: new AbortController().signal,
	});
	assert.equal(skipped.status, "skipped");
	assert.equal(store.commitInput, undefined);
	assert.equal(store.state, undefined);
	assert.deepEqual(events.map((event) => event.type), [
		"compaction_started",
		"compaction_completed",
	]);
	assert.equal(events[1]?.type, "compaction_completed");
	if (events[1]?.type === "compaction_completed") {
		assert.equal(events[1].status, "skipped");
	}
});

test("does not tokenize opaque fields in legacy provider replay state", async () => {
	const encryptedContent = "e".repeat(60_000);
	const conversation: readonly CanonicalConversationItem[] = [
		{ type: "user", text: "old request" },
		{
			type: "assistant",
			text: "old answer",
			providerState: {
				provider: "openai",
				value: {
					responsesReasoningItems: [{
						type: "reasoning",
						summary: [],
						encrypted_content: encryptedContent,
					}],
				},
			},
		},
		{ type: "user", text: "retained request" },
		{ type: "assistant", text: "retained answer" },
		{ type: "user", text: "current request" },
	];
	const store = new FakeCompactionStore(
		conversation,
		historyFixture(conversation, [
			"old-user",
			"old-assistant",
			"retained-user",
			"retained-assistant",
			"current-user",
		]),
	);

	const result = await createCoordinator({
		store,
		tokenLimit: 1_000,
		reservedOutputTokens: 100,
	}).compact({
		clientTurnId: "client-current",
		turnId: "turn-current",
		source: "pre_turn",
		conversation,
		freshItemIds: new Set(["current-user"]),
		emit: () => {},
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "not_needed");
	assert.ok(result.beforeTokens < 200);
	assert.equal(JSON.stringify(conversation).includes(encryptedContent), true);
});

test("uses provider reasoning usage to estimate replay state tokens", async () => {
	const encryptedContent = "encrypted";
	const conversation: readonly CanonicalConversationItem[] = [
		{ type: "user", text: "old request" },
		{
			type: "assistant",
			text: "old answer",
			providerState: {
				provider: "openai",
				tokenEstimate: 950,
				value: {
					responsesReasoningItems: [{
						type: "reasoning",
						summary: [],
						encrypted_content: encryptedContent,
					}],
				},
			},
		},
		{ type: "user", text: "retained request" },
		{ type: "assistant", text: "retained answer" },
		{ type: "user", text: "current request" },
	];
	const store = new FakeCompactionStore(
		conversation,
		historyFixture(conversation, [
			"old-user",
			"old-assistant",
			"retained-user",
			"retained-assistant",
			"current-user",
		]),
	);
	let summaryItems: readonly CanonicalConversationItem[] = [];

	const result = await createCoordinator({
		store,
		tokenLimit: 1_000,
		reservedOutputTokens: 100,
		summarize: async (input) => {
			summaryItems = input.items;
			return "old exchange";
		},
	}).compact({
		clientTurnId: "client-current",
		turnId: "turn-current",
		source: "pre_turn",
		conversation,
		freshItemIds: new Set(["current-user"]),
		emit: () => {},
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "compressed");
	assert.ok(result.beforeTokens >= 950);
	assert.equal(JSON.stringify(summaryItems).includes(encryptedContent), true);
	assert.equal(JSON.stringify(store.commitInput?.replacementItems).includes(encryptedContent), false);
});

test("user-requested compaction runs below the automatic threshold", async () => {
	const conversation = conversationFixture();
	const store = new FakeCompactionStore(
		conversation,
		historyFixture(conversation),
	);
	let calls = 0;
	const result = await createCoordinator({
		store,
		tokenLimit: 10_000,
		summarize: async () => {
			calls += 1;
			return "old exchange";
		},
	}).compact({
		clientTurnId: "command-compact",
		turnId: "command-compact",
		source: "user_requested" as never,
		conversation,
		freshItemIds: new Set(["current-user", "steer-q1"]),
		emit: () => {},
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "compressed");
	assert.equal(calls, 1);
});

test("forces compaction after a provider context rejection below the local estimate", async () => {
	const conversation: readonly CanonicalConversationItem[] = [
		{ type: "user", text: "first " + "history ".repeat(20) },
		{ type: "assistant", text: "answer one " + "detail ".repeat(20) },
		{ type: "user", text: "second " + "context ".repeat(20) },
		{ type: "assistant", text: "answer two " + "result ".repeat(20) },
		{ type: "user", text: "current" },
	];
	const store = new FakeCompactionStore(
		conversation,
		historyFixture(conversation, ["u1", "a1", "u2", "a2", "current-user"]),
	);
	let summaryCalls = 0;
	const result = await createCoordinator({
		store,
		tokenLimit: 1_000,
		reservedOutputTokens: 100,
		summarize: async () => {
			summaryCalls += 1;
			return "forced summary";
		},
	}).compact({
		clientTurnId: "client-current",
		turnId: "turn-current",
		source: "context_overflow",
		conversation,
		freshItemIds: new Set(["current-user"]),
		emit: () => {},
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "compressed");
	assert.equal(summaryCalls, 1);
});

test("includes stable instructions and tool schemas in the trigger budget", async () => {
	const conversation: readonly CanonicalConversationItem[] = [
		{ type: "user", text: "first request" },
		{ type: "assistant", text: "first answer" },
		{ type: "user", text: "second request" },
		{ type: "assistant", text: "second answer" },
		{ type: "user", text: "current" },
	];
	const store = new FakeCompactionStore(
		conversation,
		historyFixture(conversation, ["u1", "a1", "u2", "a2", "current-user"]),
	);
	let summaryCalls = 0;
	const result = await createCoordinator({
		store,
		tokenLimit: 100,
		reservedOutputTokens: 10,
		baseContext: "system instructions and tool schemas ".repeat(12),
		summarize: async () => {
			summaryCalls += 1;
			return "summary";
		},
	}).compact({
		clientTurnId: "client-current",
		turnId: "turn-current",
		source: "pre_turn",
		conversation,
		freshItemIds: new Set(["current-user"]),
		emit: () => {},
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "compressed");
	assert.equal(summaryCalls, 1);
	assert.ok(result.beforeTokens > 90);
});

test("resolves the latest run tool context for every compaction attempt", async () => {
	const conversation: readonly CanonicalConversationItem[] = [
		{ type: "user", text: "first request" },
		{ type: "assistant", text: "first answer" },
		{ type: "user", text: "second request" },
		{ type: "assistant", text: "second answer" },
		{ type: "user", text: "current" },
	];
	const store = new FakeCompactionStore(
		conversation,
		historyFixture(conversation, ["u1", "a1", "u2", "a2", "current-user"]),
	);
	let baseContext = "";
	let resolutions = 0;
	let summaryCalls = 0;
	const coordinator = createCoordinator({
		store,
		tokenLimit: 100,
		reservedOutputTokens: 10,
		baseContext: () => {
			resolutions += 1;
			return baseContext;
		},
		summarize: async () => {
			summaryCalls += 1;
			return "summary";
		},
	});
	const input = {
		clientTurnId: "client-current",
		turnId: "turn-current",
		source: "pre_turn" as const,
		conversation,
		freshItemIds: new Set(["current-user"]),
		emit: () => {},
		signal: new AbortController().signal,
	};

	const beforeActivation = await coordinator.compact(input);
	baseContext = "activated tool schema ".repeat(24);
	const afterActivation = await coordinator.compact(input);

	assert.equal(beforeActivation.status, "not_needed");
	assert.equal(afterActivation.status, "compressed");
	assert.ok(afterActivation.beforeTokens > beforeActivation.beforeTokens);
	assert.equal(resolutions, 2);
	assert.equal(summaryCalls, 1);
});

test("summarizes the active tool turn after a context rejection", async () => {
	const currentCalls = [
		{ callId: "call-1", name: "Read", argumentsJson: "{\"file_path\":\"a.ts\"}" },
		{ callId: "call-2", name: "Read", argumentsJson: "{\"file_path\":\"b.ts\"}" },
	] as const;
	const conversation: readonly CanonicalConversationItem[] = [
		{ type: "user", text: "old one " + "history ".repeat(20) },
		{ type: "assistant", text: "old answer one " + "detail ".repeat(20) },
		{ type: "user", text: "old two " + "context ".repeat(20) },
		{ type: "assistant", text: "old answer two " + "result ".repeat(20) },
		{ type: "user", text: "current request must stay fresh" },
		{ type: "assistant_tool_calls", text: "checking files", calls: currentCalls, responseId: "resp-tools" },
		{ type: "tool_result", callId: "call-1", toolName: "Read", output: "a contents", success: true },
		{ type: "tool_result", callId: "call-2", toolName: "Read", output: "b contents", success: true },
	];
	const history = [
		...historyFixture(conversation.slice(0, 4), ["u1", "a1", "u2", "a2"]),
		{ id: "current-user", turn_id: "turn-current", type: "user_message", text: "current request must stay fresh", metadata: {} },
		{ id: "call-history-1", turn_id: "turn-current", type: "tool_call", text: "checking files", tool_name: "Read", call_id: "call-1", metadata: { response_id: "resp-tools", arguments: { file_path: "a.ts" } } },
		{ id: "call-history-2", turn_id: "turn-current", type: "tool_call", text: "checking files", tool_name: "Read", call_id: "call-2", metadata: { response_id: "resp-tools", arguments: { file_path: "b.ts" } } },
		{ id: "result-history-1", turn_id: "turn-current", type: "tool_result", tool_name: "Read", call_id: "call-1", metadata: { success: true } },
		{ id: "result-history-2", turn_id: "turn-current", type: "tool_result", tool_name: "Read", call_id: "call-2", metadata: { success: true } },
	];
	const store = new FakeCompactionStore(conversation, history);
	let summaryItems: readonly CanonicalConversationItem[] = [];
	const result = await createCoordinator({
		store,
		summarize: async (input) => {
			summaryItems = input.items;
			return "old work summary";
		},
	}).compact({
		clientTurnId: "client-current",
		turnId: "turn-current",
		source: "context_overflow",
		conversation,
		freshItemIds: new Set(["current-user"]),
		emit: () => {},
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "compressed");
	assert.match(renderItems(summaryItems), /current request must stay fresh/u);
	assert.match(renderItems(summaryItems), /checking files/u);
	assert.match(renderItems(summaryItems), /a contents/u);
	assert.match(renderItems(summaryItems), /b contents/u);
	assert.equal(
		result.providerConversation.some((item) => item.type === "assistant_tool_calls"),
		false,
	);
	assert.equal(result.providerConversation.some((item) => item.type === "tool_result"), false);
	assert.equal(
		result.providerConversation.some(
			(item) => item.type === "user" && item.text === "current request must stay fresh",
		),
		true,
	);
	assert.deepEqual(result.providerConversation.at(-1), {
		type: "user",
		text: "[compact-summary]\nold work summary",
	});
});

test("mid-turn compaction uses the normal summary path and drops completed tool artifacts", async () => {
	const conversation: readonly CanonicalConversationItem[] = [
		{ type: "user", text: "inspect the repository" },
		{
			type: "assistant_tool_calls",
			text: "reading files",
			calls: [{
				callId: "call-read",
				name: "Read",
				argumentsJson: "{\"file_path\":\"README.md\"}",
			}],
			responseId: "resp-read",
		},
		{
			type: "tool_result",
			callId: "call-read",
			toolName: "Read",
			output: "README contents ".repeat(40),
			success: true,
		},
	];
	const store = new FakeCompactionStore(
		conversation,
		[
			{ id: "current-user", turn_id: "turn-current", type: "user_message", text: "inspect the repository", metadata: {} },
			{ id: "call-read", turn_id: "turn-current", type: "tool_call", tool_name: "Read", call_id: "call-read", metadata: {} },
			{ id: "result-read", turn_id: "turn-current", type: "tool_result", tool_name: "Read", call_id: "call-read", metadata: { success: true } },
		],
	);
	let summaryItems: readonly CanonicalConversationItem[] = [];

	const result = await createCoordinator({
		store,
		tokenLimit: 80,
		reservedOutputTokens: 10,
		summarize: async (input) => {
			summaryItems = input.items;
			return "The README was inspected.";
		},
	}).compact({
		clientTurnId: "client-current",
		turnId: "turn-current",
		source: "mid_turn",
		conversation,
		freshItemIds: new Set(["current-user"]),
		emit: () => {},
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "compressed");
	assert.deepEqual(summaryItems, conversation);
	assert.deepEqual(store.commitInput?.replacementItems, [
		{ type: "user", text: "inspect the repository" },
		{ type: "user", text: "[compact-summary]\nThe README was inspected." },
	]);
	assert.deepEqual(result.providerConversation, store.commitInput?.replacementItems);
});

test("active-turn compaction does not rehydrate file contents", async (t) => {
	const workspace = await workspaceFixture(t);
	await mkdir(join(workspace, "src"), { recursive: true });
	await writeFile(
		join(workspace, "src", "edited.ts"),
		"active turn file content must not be rehydrated\n",
		"utf8",
	);
	const conversation: readonly CanonicalConversationItem[] = [
		{ type: "user", text: "update the implementation" },
		{
			type: "assistant_tool_calls",
			text: "editing the file",
			calls: [{
				callId: "call-edit",
				name: "Edit",
				argumentsJson: "{\"file_path\":\"src/edited.ts\"}",
			}],
			responseId: "resp-edit",
		},
		{
			type: "tool_result",
			callId: "call-edit",
			toolName: "Edit",
			output: "Edit succeeded ".repeat(40),
			success: true,
		},
	];
	const history = [
		{ id: "current-user", turn_id: "turn-current", type: "user_message", text: "update the implementation", metadata: {} },
		toolCall("call-edit", "Edit", { file_path: "src/edited.ts" }),
		toolResult("result-edit", "Edit", {
			success: true,
			file_changes: [{ path: "src/edited.ts", kind: "update" }],
		}, "call-edit"),
	];

	for (const source of ["mid_turn", "context_overflow"] as const) {
		const store = new FakeCompactionStore(conversation, history);
		const result = await createCoordinator({
			store,
			workspaceRoot: workspace,
			tokenLimit: 80,
			reservedOutputTokens: 10,
			summarize: async () => "The implementation was updated.",
		}).compact({
			clientTurnId: "client-current",
			turnId: "turn-current",
			source,
			conversation,
			freshItemIds: new Set(["current-user"]),
			emit: () => {},
			signal: new AbortController().signal,
		});

		assert.equal(result.status, "compressed", source);
		assert.deepEqual(result.rehydration, [], source);
		assert.doesNotMatch(
			JSON.stringify(result.providerConversation),
			/active turn file content must not be rehydrated/u,
		);
		assert.equal(
			JSON.stringify(recordValue(store.commitInput?.checkpoint)).includes("rehydration_items"),
			true,
		);
		assert.deepEqual(
			recordValue(store.commitInput?.checkpoint).rehydration_items,
			[],
			source,
		);
	}
});

test("rehydrates edited files before reads within path, item, total, and count bounds", async (t) => {
	const workspace = await workspaceFixture(t);
	await mkdir(join(workspace, "src"), { recursive: true });
	await mkdir(join(workspace, ".mycli"), { recursive: true });
	await writeFile(join(workspace, "src", "edited.ts"), "edited current content\n", "utf8");
	await writeFile(join(workspace, "src", "read.ts"), "read current content\n", "utf8");
	await writeFile(join(workspace, ".mycli", "state.md"), "state must stay private\n", "utf8");
	const outside = join(workspace, "..", "outside.ts");
	await writeFile(outside, "outside content\n", "utf8");
	await symlink(outside, join(workspace, "src", "escaped.ts"));
	const conversation = conversationFixture();
	const conversationHistory = historyFixture(conversation);
	const history = [
		...conversationHistory.slice(0, -2),
		toolResult("edit-result", "Edit", {
			file_changes: [{ path: "src/edited.ts", kind: "update" }],
		}),
		toolCall("read-call", "Read", { file_path: "src/read.ts" }),
		toolResult("read-result", "Read", { success: true }, "read-call"),
		toolCall("state-call", "Read", { file_path: ".mycli/state.md" }),
		toolResult("state-result", "Read", { success: true }, "state-call"),
		toolCall("escape-call", "Read", { file_path: "src/escaped.ts" }),
		toolResult("escape-result", "Read", { success: true }, "escape-call"),
		...conversationHistory.slice(-2),
	];
	const store = new FakeCompactionStore(conversation, history);
	const result = await createCoordinator({
		store,
		workspaceRoot: workspace,
		rehydrationMaxFiles: 2,
		rehydrationMaxItemTokens: 20,
		rehydrationMaxTotalTokens: 30,
	}).compact({
		clientTurnId: "client-current",
		turnId: "turn-current",
		source: "pre_turn",
		conversation,
		freshItemIds: new Set(["current-user", "steer-q1"]),
		emit: () => {},
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "compressed");
	assert.deepEqual(result.rehydration.map((item) => item.path), [
		"src/edited.ts",
		"src/read.ts",
	]);
	assert.ok(result.rehydration.reduce((total, item) => total + item.tokens, 0) <= 30);
	assert.equal(JSON.stringify(store.commitInput?.replacementMessages).includes("rehydration"), false);
	const boundaryCheckpoint = recordValue(store.commitInput?.checkpoint);
	assert.equal(Array.isArray(boundaryCheckpoint.retained_tail_messages), true);
	assert.deepEqual(
		(boundaryCheckpoint.rehydration_items as readonly { readonly path: string }[])
			.map((item) => item.path),
		["src/edited.ts", "src/read.ts"],
	);
	assert.match(JSON.stringify(boundaryCheckpoint.rehydration_items), /edited current content/u);
	assert.equal(JSON.stringify(result.providerConversation).includes("edited current content"), true);
	assert.equal(JSON.stringify(result.providerConversation).includes("state must stay private"), false);
	assert.equal(JSON.stringify(result.providerConversation).includes("outside content"), false);
	const counter = new TokenCounter({
		loadEncoder: () => { throw new Error("force deterministic fallback"); },
	});
	const storedTokens = countConversationTokens(counter, store.commitInput?.replacementItems ?? []);
	const providerTokens = countConversationTokens(counter, result.providerConversation);
	assert.equal(result.afterTokens, providerTokens);
	assert.ok(result.afterTokens > storedTokens);
});

test("uses provider-only rehydration when enforcing the minimum savings ratio", async (t) => {
	const workspace = await workspaceFixture(t);
	await mkdir(join(workspace, "src"), { recursive: true });
	await writeFile(
		join(workspace, "src", "large.ts"),
		"rehydration payload ".repeat(3_000),
		"utf8",
	);
	const conversation: readonly CanonicalConversationItem[] = [
		{ type: "user", text: "old request " + "history ".repeat(1_500) },
		{ type: "assistant", text: "old answer " + "detail ".repeat(1_500) },
		{ type: "user", text: "retained request" },
		{ type: "assistant", text: "retained answer" },
		{ type: "user", text: "current request" },
	];
	const history = [
		...historyFixture(conversation.slice(0, 4), ["u1", "a1", "u2", "a2"]),
		toolResult("edit-result", "Edit", {
			success: true,
			file_changes: [{ path: "src/large.ts", kind: "update" }],
		}),
		{ id: "current-user", turn_id: "turn-current", type: "user_message", text: "current request", metadata: {} },
	];
	const store = new FakeCompactionStore(conversation, history);

	const result = await createCoordinator({
		store,
		workspaceRoot: workspace,
		minSavingsRatio: 0.5,
	}).compact({
		clientTurnId: "client-current",
		turnId: "turn-current",
		source: "pre_turn",
		conversation,
		freshItemIds: new Set(["current-user"]),
		emit: () => {},
		signal: new AbortController().signal,
	});

	assert.equal(result.status, "skipped");
	assert.equal(store.commitInput, undefined);
});

function createCoordinator(overrides: Partial<Omit<CompactionCoordinatorOptions, "store">> & {
	readonly store: FakeCompactionStore;
}): CompactionCoordinator {
	const { store, ...rest } = overrides;
	return new CompactionCoordinator({
		sessionId: "session-1",
		workspaceRoot: "/workspace",
		threadId: "thread-1",
		store,
		tokenCounter: new TokenCounter({
			loadEncoder: () => { throw new Error("force deterministic fallback"); },
		}),
		tokenLimit: 30,
		reservedOutputTokens: 10,
		triggerRatio: 1,
		tailTurns: 1,
		tailMaxTokens: 100,
		minSavingsRatio: 0,
		summaryMaxTokens: 100,
		summaryModel: "summary-model",
		rehydrationMaxFiles: 5,
		rehydrationMaxItemTokens: 5_000,
		rehydrationMaxTotalTokens: 50_000,
		summarize: async () => "Earlier work and decisions.",
		createCheckpointId: () => "compact-1",
		clock: () => "2026-08-04T00:00:00.000Z",
		monotonicClock: () => 100,
		...rest,
	});
}

function conversationFixture(): readonly CanonicalConversationItem[] {
	return Object.freeze([
		{ type: "user", text: "first request " + "history ".repeat(20) },
		{ type: "assistant", text: "first answer " + "detail ".repeat(20) },
		{ type: "user", text: "second request " + "context ".repeat(20) },
		{ type: "assistant", text: "second answer " + "result ".repeat(20) },
		{ type: "user", text: "current request" },
		{ type: "user", text: "fresh steer" },
	]);
}

function historyFixture(
	conversation: readonly CanonicalConversationItem[],
	ids: readonly string[] = [
		"old-user-1",
		"old-assistant-1",
		"old-user-2",
		"old-assistant-2",
		"current-user",
		"steer-q1",
	],
): readonly Readonly<Record<string, unknown>>[] {
	return conversation.map((item, index) => ({
		id: ids[index] ?? `history-${index}`,
		type: item.type === "user" ? "user_message" : "assistant_message",
		text: "text" in item ? item.text : "",
		turn_id: index >= conversation.length - 2 ? "turn-current" : `turn-${index}`,
		metadata: {},
	}));
}

function toolCall(
	id: string,
	toolName: string,
	args: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	return {
		id,
		type: "tool_call",
		tool_name: toolName,
		call_id: id,
		metadata: { arguments: args },
	};
}

function toolResult(
	id: string,
	toolName: string,
	metadata: Readonly<Record<string, unknown>>,
	callId = id,
): Readonly<Record<string, unknown>> {
	return {
		id,
		type: "tool_result",
		tool_name: toolName,
		call_id: callId,
		metadata,
	};
}

function inProgressCheckpoint(
	conversation: readonly CanonicalConversationItem[],
): Readonly<Record<string, unknown>> {
	return {
		version: 1,
		turn_id: "turn-current",
		reason: "context_limit",
		phase: "pre_turn",
		window_number: 1,
		window_id: "compact-old",
		history_item_count: conversation.length,
		input_history_hash: "input-hash",
		replacement_history_hash: "input-hash",
		replacement_messages: [{ role: "user", content: "placeholder" }],
		status: "in_progress",
		summary_request_fingerprint: "summary-fingerprint",
	};
}

function renderItems(items: readonly CanonicalConversationItem[]): string {
	return items.map((item) => {
		switch (item.type) {
			case "user":
			case "assistant":
				return item.text;
			case "assistant_tool_calls":
				return `${item.text} ${item.calls.map((call) => call.argumentsJson).join(" ")}`;
			case "tool_result":
				return item.output;
		}
	}).join("\n");
}

function countConversationTokens(
	counter: TokenCounter,
	items: readonly CanonicalConversationItem[],
): number {
	return items.reduce((total, item) => total + counter.count(renderConversationItem(item)), 0);
}

function renderConversationItem(item: CanonicalConversationItem): string {
	switch (item.type) {
		case "user":
		case "assistant":
			return `${item.type}: ${item.text}`;
		case "context":
			return `context ${item.metadata.kind}: ${item.text}`;
		case "assistant_tool_calls":
			return `assistant_tool_calls: ${item.text}\n${item.calls.map((call) => (
				`${call.name} ${call.callId} ${call.argumentsJson}`
			)).join("\n")}`;
		case "tool_result":
			return `tool_result ${item.toolName} ${item.callId} ${String(item.success)}: ${item.output}`;
	}
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Readonly<Record<string, unknown>>
		: {};
}

async function workspaceFixture(t: TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "mycli-compaction-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

function providerConfig(): ProviderRequestConfig {
	return {
		provider: "openai",
		protocol: "responses",
		model: "main-model",
	};
}

async function* providerEvents(events: readonly ProviderEvent[]): AsyncIterable<ProviderEvent> {
	for (const event of events) yield event;
}

class FakeCompactionStore {
	readonly historyItems: readonly Readonly<Record<string, unknown>>[];
	providerConversation: readonly Readonly<Record<string, unknown>>[];
	state: Readonly<Record<string, unknown>> | undefined;
	readonly savedStates: SaveStateInput[] = [];
	commitInput: CommitCompactionInput | undefined;
	failCommit = false;

	constructor(
		conversation: readonly CanonicalConversationItem[],
		historyItems: readonly Readonly<Record<string, unknown>>[],
	) {
		this.historyItems = historyItems;
		this.providerConversation = conversation.map((item) => ({
			role: item.type === "assistant" || item.type === "assistant_tool_calls"
				? "assistant"
				: item.type === "tool_result" ? "tool" : "user",
			content: "text" in item ? item.text : item.output,
		}));
	}

	loadState(): unknown | undefined {
		return this.state;
	}

	saveState(input: SaveStateInput): void {
		this.savedStates.push(input);
		this.state = input.payload as Readonly<Record<string, unknown>>;
	}

	deleteState(): void {
		this.state = undefined;
	}

	loadHistoryItems(): readonly Readonly<Record<string, unknown>>[] {
		return this.historyItems;
	}

	commitCompaction(input: CommitCompactionInput): void {
		if (this.failCommit) throw new Error("commit failed");
		this.commitInput = input;
		this.state = input.checkpoint;
		this.providerConversation = structuredClone(input.replacementMessages);
	}
}
