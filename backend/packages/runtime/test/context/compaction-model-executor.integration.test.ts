import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NODE_RUNTIME_CONTEXT_DEFAULTS, type NodeRuntimeConfig } from "@mycli/config";
import { fingerprintSubmission, type CanonicalConversationItem, type ProviderRequest } from "@mycli/core";
import { ProviderRegistry, ProviderFailure, type ModelProvider } from "@mycli/providers";
import { openRuntimeSessionStore, projectTranscript, type RuntimeSessionStore } from "@mycli/storage";
import { CompactionCoordinator, type CompactionRuntimeEvent } from "../../src/context/compaction-coordinator.ts";
import { summarizeCompactionWithProvider, type CompactionModelEvent } from "../../src/context/compaction-model-executor.ts";
import { CompactionModelJournal } from "../../src/context/compaction-model-journal.ts";
import { SessionGoalService } from "../../src/sessions/session-goal-service.ts";
import { compactionSummaryInstruction } from "../../src/context/compaction-summary.ts";

const NOW = "2026-09-07T10:00:00.000Z";
const SESSION = "compaction-test";

test("manual compaction shares retries and journals attempts and usage before returning", async (t) => {
	let calls = 0;
	const fixture = await createFixture(t, { stream: async function* () {
		calls += 1;
		assert.equal(attempts(fixture.store).at(-1)?.state, "started");
		yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
		if (calls === 1) throw temporaryFailure();
		yield { type: "text_delta", text: "Internal summary." };
		yield { type: "completed" };
	} });
	const result = await fixture.compact();
	assert.equal(result.status, "compressed");
	assert.equal(calls, 2);
	assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 4 });
	assert.deepEqual(attempts(fixture.store).map((attempt) => attempt.state),
		["started", "failed", "scheduled", "started", "recovered"]);
	assert.equal(fixture.events.filter((event) => event.type === "compaction_progress").length, 1);
	assert.equal(fixture.store.loadTurn(SESSION, "manual-command"), undefined);
	assert.equal(fixture.events.some((event) => (event as { type: string }).type === "text_delta"), false);
	const readable = JSON.stringify(projectTranscript(fixture.store.loadHistoryItems(SESSION), []));
	assert.match(readable, /Context compression: Reconnecting/u);
	assert.doesNotMatch(readable, /usage recorded|request started/u);
	assert.equal(fixture.store.loadHistoryItems(SESSION).some((item) => item.type === "assistant_message"
		&& String(item.text).includes("Internal summary.")), false);
	const reopened = openRuntimeSessionStore({ dbPath: fixture.dbPath });
	try {
		assert.deepEqual(attempts(reopened), attempts(fixture.store));
		assert.equal(reopened.loadState(SESSION, "compact_checkpoint")?.valueOf() !== undefined, true);
	} finally { reopened.close(); }
});

test("compaction retains an auth failure without retry and safe details survive transcript replay", async (t) => {
	let calls = 0;
	const fixture = await createFixture(t, { stream: async function* () {
		calls += 1;
		yield { type: "usage", usage: { inputTokens: 4 } };
		throw new ProviderFailure({ code: "auth_error", message: "authentication rejected", retryable: false,
			publicDetail: "upstream denied token=synthetic-secret", diagnostics: { status: 401, request_id: "req-auth" } });
	} });
	const before = fixture.store.loadConversationItems(SESSION);
	const result = await fixture.compact();
	assert.equal(result.status, "failed");
	assert.equal(result.failure?.code, "auth_error");
	assert.equal(calls, 1);
	assert.deepEqual(result.usage, { inputTokens: 4 });
	assert.deepEqual(fixture.store.loadConversationItems(SESSION), before);
	const reopened = openRuntimeSessionStore({ dbPath: fixture.dbPath });
	try {
		const history = reopened.loadHistoryItems(SESSION);
		const projected = JSON.stringify(projectTranscript(history, []));
		assert.match(projected, /upstream denied/u);
		assert.match(projected, /auth_error/u);
		assert.doesNotMatch(JSON.stringify(history), /synthetic-secret/u);
		assert.match(projected, /REDACTED/u);
	} finally { reopened.close(); }
});

test("canceling compaction during retry delay commits cancellation and never dispatches again", async (t) => {
	let calls = 0;
	const controller = new AbortController();
		const fixture = await createFixture(t, { stream: async function* () {
			calls += 1;
			yield await Promise.reject(temporaryFailure());
		} }, { signal: controller.signal, sleep: async () => { controller.abort(); controller.signal.throwIfAborted(); } });
	const result = await fixture.compact();
	assert.equal(result.status, "interrupted");
	assert.equal(calls, 1);
	assert.equal(attempts(fixture.store).at(-1)?.state, "cancelled");
	assert.equal(fixture.store.loadState(SESSION, "compact_checkpoint"), undefined);
});

test("a compaction attempt persistence failure prevents provider dispatch", async (t) => {
	let calls = 0;
	const fixture = await createFixture(t, { stream: async function* () {
		calls += 1;
		yield { type: "completed" };
	} });
	fixture.store.appendCompactionActivity = () => { throw new Error("injected persistence failure"); };
	await assert.rejects(fixture.compact, /injected persistence failure/u);
	assert.equal(calls, 0);
});

test("another SQLite connection cannot clear or commit a successor checkpoint", async (t) => {
	const fixture = await createFixture(t, { stream: async function* () {
		yield { type: "text_delta", text: "Internal summary." };
		yield { type: "completed" };
	} });
	assert.equal((await fixture.compact()).status, "compressed");
	const completed = fixture.store.loadState(SESSION, "compact_checkpoint") as Record<string, unknown>;
	const successor: Record<string, unknown> = { ...completed, status: "in_progress", window_id: "successor", turn_id: "successor-turn" };
	delete successor.transcript_event_id;
	successor.replacement_messages = [];
	fixture.store.saveState({ sessionId: SESSION, workspaceRoot: fixture.root, threadId: SESSION,
		key: "compact_checkpoint", payload: successor });
	const other = openRuntimeSessionStore({ dbPath: fixture.dbPath });
	try {
		assert.equal(other.compareAndSetState({ sessionId: SESSION, workspaceRoot: fixture.root,
			threadId: SESSION, key: "compact_checkpoint", expectedPayload: completed, payload: undefined }), false);
		const before = other.loadConversationItems(SESSION);
		assert.equal(other.commitCompaction({ sessionId: SESSION, expectedCheckpoint: completed,
			checkpoint: completed, summary: "stale", replacementItems: [{ type: "user", text: "stale" }],
			replacementMessages: [] }), false);
		assert.deepEqual(other.loadConversationItems(SESSION), before);
		assert.deepEqual(other.loadState(SESSION, "compact_checkpoint"), successor);
	} finally { other.close(); }
});

test("DeepSeek accepts a completed summary above 4096 tokens in one request with current reasoning", async (t) => {
	const bodies: Record<string, unknown>[] = [];
	const summary = ("Summary with <|endoftext|>. " + "documentation ".repeat(10_000)).trim();
	const provider = deepSeekProvider((body) => {
		bodies.push(body);
		return { text: summary, finish: "stop", tokens: 10876 };
	});
	const fixture = await createFixture(t, provider, { goalBudget: 100_000,
		config: { provider: "deepseek", protocol: "chat_completions", model: "deepseek-v4-flash-vision-exp",
			reasoningEffort: "high", maxOutputTokens: 20_000 } });
	const result = await fixture.compact();
	assert.equal(result.status, "compressed");
	assert.equal(bodies.length, 1);
	assert.equal(bodies[0]?.max_tokens, 20_000);
	assert.deepEqual(bodies[0]?.thinking, { type: "enabled" });
	assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 10876, total_tokens: 10886 });
	assert.equal(fixture.goal?.get()?.tokens_used, 10886);
	assert.ok(result.afterTokens > result.beforeTokens, "a completed summary is not rejected by a local savings gate");
	const saved = fixture.store.loadConversationItems(SESSION);
	const savedSummary = saved.at(-1);
	assert.ok(savedSummary?.type === "user" && savedSummary.text.endsWith(summary));
	assert.equal(saved.some((item) => item.type === "assistant"), false);
	assert.equal(fixture.events.filter((event) => event.type === "compaction_progress").length, 0);
	const reopened = openRuntimeSessionStore({ dbPath: fixture.dbPath });
	try { assert.deepEqual(reopened.loadConversationItems(SESSION), saved); } finally { reopened.close(); }
});

test("SDK summary requests retain base instructions and tool messages with the handoff request last", async (t) => {
	const bodies: Record<string, unknown>[] = [];
	const provider = deepSeekProvider((body) => { bodies.push(body); return { text: "Summary.", finish: "stop", tokens: 4 }; });
	const fixture = await createFixture(t, provider);
	const instruction = compactionSummaryInstruction();
	const items: CanonicalConversationItem[] = [
		{ type: "user", text: "Search the repository for <|endoftext|>." },
		{ type: "assistant_tool_calls", text: "Read findings.", calls: [{ callId: "read-1", name: "Read", argumentsJson: '{"file_path":"app.ts"}' }] },
		{ type: "tool_result", callId: "read-1", toolName: "Read", success: true, output: "Recorded file contents." },
	];
	await summarizeCompactionWithProvider(provider, { ...fixture.config, provider: "deepseek", protocol: "chat_completions", model: "deepseek-v4-flash-vision-exp" }, {
		items, instruction, baseInstructions: "You are a coding agent.", developerInstructions: ["Use TypeScript."], signal: new AbortController().signal,
	});
	const messages = bodies[0]!.messages as { role: string; content: string; tool_calls?: unknown; tool_call_id?: string }[];
	assert.match(messages.find((message) => message.role === "system")?.content ?? "", /You are a coding agent/u);
	assert.match(JSON.stringify(messages), /Use TypeScript/u);
	assert.equal(messages.at(-1)?.role, "user");
	assert.equal(messages.at(-1)?.content, instruction);
	assert.ok(messages.some((message) => message.role === "assistant" && message.tool_calls));
	assert.ok(messages.some((message) => message.role === "tool" && message.content === "Recorded file contents."));
	assert.doesNotMatch(JSON.stringify(messages), /historical_item|draft_summary/u);
	assert.deepEqual(bodies[0]?.tools ?? [], []);
});

test("context rejection trims the request and resets transport retries without losing attempt usage", async (t) => {
	const requests: ProviderRequest[] = [];
	const fixture = await createFixture(t, { stream: async function* (request) {
		requests.push(request);
		yield { type: "usage", usage: { input_tokens: 10, output_tokens: 2 } };
		if (requests.length === 1 || requests.length === 3) throw temporaryFailure();
		if (requests.length === 2) throw contextLimitFailure();
		yield { type: "text_delta", text: "Context summary." };
		yield { type: "completed" };
	} }, { goalBudget: 100_000, config: { maxOutputTokens: 2_000 } });
	const before = fixture.store.loadConversationItems(SESSION);
	assert.equal((await fixture.compact()).status, "compressed");
	assert.equal(requests.length, 4);
	assert.deepEqual(requests[0]?.items, requests[1]?.items);
	assert.deepEqual(requests[2]?.items, requests[3]?.items);
	assert.deepEqual(requests[2]?.items?.slice(0, -1), before.slice(1));
	assert.equal(requests[2]?.instructions, "You are a coding agent.");
	assert.equal(fixture.goal?.get()?.tokens_used, 48);
	const history = fixture.store.loadHistoryItems(SESSION);
	const usageAttempts = history.flatMap((item) => {
		const metadata = item.metadata as Record<string, unknown> | undefined;
		return metadata?.event_kind === "compaction_model" && metadata.usage ? [metadata.attempt] : [];
	});
	assert.deepEqual(usageAttempts, [1, 2, 3, 4]);
	const started = attempts(fixture.store).filter((attempt) => attempt.state === "started");
	assert.deepEqual(started.map((attempt) => attempt.attempt), [1, 2, 1, 2]);
	assert.deepEqual(started.map((attempt) => attempt.sequence), [1, 4, 6, 9]);
	assert.match(JSON.stringify(projectTranscript(history, [])), /older history was removed/u);
	assert.ok(fixture.store.loadConversationItems(SESSION).some((item) => item.type === "user" && item.text === "first"),
		"request trimming must not remove retained user intent from the replacement");
});

test("context trimming removes a tool batch and paired results while preserving the latest user", async (t) => {
	let calls = 0;
	const fixture = await createFixture(t, { stream: async function* () { yield { type: "completed" }; } });
	const items: CanonicalConversationItem[] = [
		{ type: "assistant_tool_calls", text: "Reading.", calls: [{ callId: "read-1", name: "Read", argumentsJson: "{}" }] },
		{ type: "tool_result", callId: "read-1", toolName: "Read", output: "Large output", success: true },
		{ type: "user", text: "Latest request" },
	];
	const before = structuredClone(items);
	const summary = await summarizeCompactionWithProvider({ stream: async function* (request) {
		calls += 1;
		if (calls === 1) throw contextLimitFailure();
		assert.deepEqual(request.items, [items[2], { type: "user", text: compactionSummaryInstruction() }]);
		yield { type: "text_delta", text: "Summary." };
		yield { type: "completed" };
	} }, fixture.config, { items, baseInstructions: "Base instructions.", instruction: compactionSummaryInstruction(), signal: new AbortController().signal });
	assert.equal(summary, "Summary.");
	assert.equal(calls, 2);
	assert.deepEqual(items, before);
});

test("context recovery stops when only the summarization request remains", async (t) => {
	let calls = 0;
	const fixture = await createFixture(t, { stream: async function* () {
		calls += 1;
		yield await Promise.reject(contextLimitFailure());
	} });
	const before = fixture.store.loadConversationItems(SESSION);
	const result = await fixture.compact();
	assert.equal(result.status, "failed");
	assert.equal(result.failure?.code, "context_window_exceeded");
	assert.equal(calls, before.length + 1);
	assert.deepEqual(fixture.store.loadConversationItems(SESSION), before);
});

test("model and user output ceilings apply without a separate summary limit or reasoning override", async (t) => {
	for (const scenario of ["model", "user", "unspecified"] as const) await t.test(scenario, async (t) => {
		let request: ProviderRequest | undefined;
		const fixture = await createFixture(t, {
			resolveCapabilities: async () => ({ supportsImages: false, reasoningEfforts: ["none", "low", "high"],
				...(scenario === "unspecified" ? {} : { maxOutputTokens: 8_000 }) }),
			stream: async function* (input) { request = input; yield { type: "text_delta", text: "Summary." }; yield { type: "completed" }; },
		}, { config: { reasoningEffort: "high", ...(scenario === "user" ? { maxOutputTokens: 6_000 } : {}) } });
		assert.equal((await fixture.compact()).status, "compressed");
		assert.equal(request?.reasoningEffort, "high");
		assert.equal(request?.maxOutputTokens, scenario === "model" ? 8_000 : scenario === "user" ? 6_000 : undefined);
	});
});

test("estimated context overflow trims old input before dispatch, while instruction and Goal exhaustion stop", async (t) => {
	for (const scenario of ["trim", "instructions", "goal"] as const) await t.test(scenario, async (t) => {
		let request: ProviderRequest | undefined;
		const fixture = await createFixture(t, {
			resolveCapabilities: async () => ({ supportsImages: false, contextWindowTokens: scenario === "instructions" ? 10 : 400 }),
			stream: async function* (input) { request = input; yield { type: "text_delta", text: "Summary." }; yield { type: "completed" }; },
		}, scenario === "goal" ? { remainingTokenBudget: () => 10 } : {});
		const before = fixture.store.loadConversationItems(SESSION);
		const result = await fixture.compact();
		assert.equal(result.status, scenario === "trim" ? "compressed" : "failed");
		if (scenario === "trim") assert.ok((request?.items?.length ?? 0) < before.length + 1);
		else {
			assert.equal(request, undefined);
			assert.equal(result.failure?.code, scenario === "instructions" ? "context_window_exceeded" : "tool_budget_exceeded");
			assert.deepEqual(fixture.store.loadConversationItems(SESSION), before);
		}
	});
});

test("output limits, empty results and auth failures do not create corrective summary requests", async (t) => {
	for (const failure of ["length", "empty", "auth"] as const) await t.test(failure, async (t) => {
		let calls = 0;
		const fixture = await createFixture(t, { stream: async function* () {
			calls += 1;
			if (failure === "length") throw outputLimitFailure();
			if (failure === "auth") throw new ProviderFailure({ code: "auth_error", message: "denied" });
			yield { type: "completed" };
		} });
		const before = fixture.store.loadConversationItems(SESSION);
		const result = await fixture.compact();
		assert.equal(result.status, "failed");
		assert.equal(calls, 1);
		assert.deepEqual(fixture.store.loadConversationItems(SESSION), before);
		if (failure === "empty") assert.equal(result.failure?.errorContext?.reason, "provider.empty_response");
		if (failure === "length") assert.equal(result.failure?.errorContext?.reason, "provider.output_limit");
	});
});

test("partial text without stream completion never replaces the active window", async (t) => {
	const fixture = await createFixture(t, { stream: async function* () { yield { type: "text_delta", text: "Unfinished summary." }; } },
		{ config: { requestMaxRetries: 0, streamMaxRetries: 0 } });
	const before = fixture.store.loadConversationItems(SESSION);
	assert.equal((await fixture.compact()).status, "failed");
	assert.deepEqual(fixture.store.loadConversationItems(SESSION), before);
});

test("cancel, ownership loss and Goal budget changes fence dispatch after context trimming", async (t) => {
	for (const scenario of ["cancel", "cancel_recovery", "ownership", "exhausted", "budget_changed"] as const) await t.test(scenario, async (t) => {
		const controller = new AbortController();
		let calls = 0;
		let remaining: number | undefined;
		const fixture = await createFixture(t, { stream: async function* () {
			calls += 1;
			yield { type: "usage", usage: { input_tokens: 10, output_tokens: scenario === "exhausted" ? 30_000 : 100 } };
			throw contextLimitFailure();
		} }, { signal: controller.signal, goalBudget: 20_000,
			...(scenario === "budget_changed" ? { remainingTokenBudget: () => remaining } : {}),
			onModelEvent: (event) => {
				if (event.type !== "recovery" && !(event.type === "attempt" && event.update.state === "failed")) return;
				if (scenario === "cancel") controller.abort();
				if (scenario === "cancel_recovery" && event.type === "recovery") controller.abort();
				if (scenario === "ownership") fixture.store.saveState({ sessionId: SESSION, workspaceRoot: fixture.root,
					threadId: SESSION, key: "compact_checkpoint", payload: { ...fixture.store.loadState(SESSION, "compact_checkpoint") as Record<string, unknown>,
						window_id: "successor", turn_id: "successor-turn" } });
				if (scenario === "budget_changed" && event.type === "recovery") remaining = 0;
			},
		});
		const before = fixture.store.loadConversationItems(SESSION);
		const result = await fixture.compact();
		assert.equal(calls, 1);
		assert.equal(result.status, scenario === "cancel" || scenario === "cancel_recovery" || scenario === "ownership" ? "interrupted" : "failed");
		assert.deepEqual(fixture.store.loadConversationItems(SESSION), before);
		if (scenario === "ownership") assert.equal((fixture.store.loadState(SESSION, "compact_checkpoint") as { window_id: string }).window_id, "successor");
	});
});

test("failed compaction restores the previous completed SQLite checkpoint", async (t) => {
	for (const failure of ["output_limit", "empty", "context"] as const) await t.test(failure, async (t) => {
		let fail = false;
		const fixture = await createFixture(t, { stream: async function* () {
			if (fail && failure === "output_limit") throw outputLimitFailure();
			if (fail && failure === "context") throw contextLimitFailure();
			yield { type: "text_delta", text: fail ? " " : "A compact summary of completed work." };
			yield { type: "completed" };
		} });
		assert.equal((await fixture.compact()).status, "compressed");
		const checkpoint = fixture.store.loadState(SESSION, "compact_checkpoint");
		const before = fixture.store.loadConversationItems(SESSION);
		fail = true;
		assert.equal((await fixture.compact()).status, "failed");
		assert.deepEqual(fixture.store.loadState(SESSION, "compact_checkpoint"), checkpoint);
		assert.deepEqual(fixture.store.loadConversationItems(SESSION), before);
	});
});

function contextLimitFailure(): ProviderFailure {
	return new ProviderFailure({ code: "context_window_exceeded", message: "context window exceeded" });
}

function outputLimitFailure(): ProviderFailure {
	return new ProviderFailure({ code: "provider_error", message: "length", errorReason: { reason: "provider.output_limit", details: { finish_reason: "length" } } });
}

async function createFixture(t: test.TestContext, provider: ModelProvider, options: {
	readonly signal?: AbortSignal;
	readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
	readonly config?: Partial<NodeRuntimeConfig>;
	readonly goalBudget?: number;
	readonly onModelEvent?: (event: CompactionModelEvent) => void;
	readonly remainingTokenBudget?: () => number | undefined;
} = {}): Promise<{
	readonly root: string;
	readonly dbPath: string;
	readonly store: RuntimeSessionStore;
	readonly events: CompactionRuntimeEvent[];
	readonly goal?: SessionGoalService;
	readonly config: NodeRuntimeConfig;
	readonly compact: () => ReturnType<CompactionCoordinator["compact"]>;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-compaction-"));
	const dbPath = join(root, "session.db");
	const store = openRuntimeSessionStore({ dbPath });
	t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
	for (const id of ["first", "second"]) {
		store.reserveTurn({ sessionId: SESSION, turnId: id, clientTurnId: id, clientUserMessageId: id,
			requestFingerprint: fingerprintSubmission({ message: id, localImages: [] }),
			workspaceRoot: root, threadId: SESSION, userText: id, startedAt: NOW });
		store.completeTurn({ sessionId: SESSION, clientTurnId: id, assistantText: "context ".repeat(250),
			usage: {}, completedAt: NOW });
	}
	const config: NodeRuntimeConfig = {
		...NODE_RUNTIME_CONTEXT_DEFAULTS, workspaceRoot: root, homeDir: root,
		provider: "openai", protocol: "responses", model: "test-model", apiBaseUrl: "https://unused.invalid/v1",
		apiKey: "synthetic-key", authRef: "test", sessionId: SESSION, sessionsDbPath: dbPath,
		maxPromptTokens: 16000, requestMaxRetries: 1, streamMaxRetries: 1, reasoningEffort: "none",
		thinkingEnabled: false, supportsImages: false, webSearchMode: "disabled", cacheRetention: "none",
		requestPermissionsToolEnabled: false, updatesCheckOnStartup: false,
		...options.config,
	};
	const goal = options.goalBudget === undefined ? undefined : new SessionGoalService({
		store: store.goals, sessionId: SESSION, workspaceRoot: root, threadId: SESSION,
	});
	const goalId = goal?.create({ objective: "Finish", tokenBudget: options.goalBudget }).goal_id;
	const journal = new CompactionModelJournal({ sessionId: SESSION, store, clock: () => NOW });
	const events: CompactionRuntimeEvent[] = [];
	const coordinator = new CompactionCoordinator({
		sessionId: SESSION, workspaceRoot: root, threadId: SESSION, store,
		tokenLimit: 200, reservedOutputTokens: 20, retainedUserMaxTokens: 20_000,
		baseInstructions: "You are a coding agent.",
		createCheckpointId: () => "checkpoint-summary", clock: () => NOW,
		recordModelEvent: (evidence) => journal.record(evidence),
		summarize: (input) => summarizeCompactionWithProvider(provider, config, { ...input,
			remainingTokenBudget: options.remainingTokenBudget ?? (() => goalId ? goal?.remainingTokenBudget(goalId) : undefined),
			recordEvent: async (event) => {
				await input.recordEvent(event);
				if (event.type === "usage" && goalId) goal?.observeAttributedUsage(goalId, `compaction:${input.operationId}:${event.attempt}`, event.usage);
				options.onModelEvent?.(event);
			},
		}, {
			sleep: options.sleep ?? (async () => {}), random: () => 0, clock: () => NOW,
		}),
	});
	return { root, dbPath, store, events, goal, config, compact: () => coordinator.compact({
		clientTurnId: "manual-command", turnId: "manual-command", source: "user_requested",
		conversation: store.loadConversationItems(SESSION), freshItemIds: new Set(),
		emit: (event) => { events.push(event); }, signal: options.signal ?? new AbortController().signal,
	}) };
}

function attempts(store: RuntimeSessionStore): readonly Record<string, unknown>[] {
	return store.loadHistoryItems(SESSION).flatMap((item) => {
		const metadata = item.metadata as Record<string, unknown> | undefined;
		return metadata?.provider_attempt ? [metadata.provider_attempt as Record<string, unknown>] : [];
	});
}

function temporaryFailure(): ProviderFailure {
	return new ProviderFailure({ code: "response_stream_error", message: "upstream failed", retryable: true,
		publicDetail: "stream_read_error", diagnostics: { upstream_code: "stream_read_error", status: 200 } });
}

function deepSeekProvider(reply: (body: Record<string, unknown>) => {
	readonly text: string; readonly finish: "stop" | "length"; readonly tokens: number;
}): ModelProvider {
	return new ProviderRegistry({ fetch: async (_url, init) => {
		const response = reply(JSON.parse(init!.body as string) as Record<string, unknown>);
		const frames = [
			{ id: "summary", choices: [{ index: 0, delta: { role: "assistant", content: response.text }, finish_reason: null }] },
			{ id: "summary", choices: [{ index: 0, delta: {}, finish_reason: response.finish }] },
			{ id: "summary", choices: [], usage: { prompt_tokens: 10, completion_tokens: response.tokens, total_tokens: 10 + response.tokens } },
		];
		return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
			{ headers: { "content-type": "text/event-stream" } });
	} }).create({ provider: "deepseek", protocol: "chat_completions", model: "deepseek-v4-flash-vision-exp",
		apiKey: "fixture", apiBaseUrl: "https://offline.invalid/v1", supportsImages: false, maxPromptTokens: 64_000 });
}
