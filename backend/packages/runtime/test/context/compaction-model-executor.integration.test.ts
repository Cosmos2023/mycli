import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NODE_RUNTIME_CONTEXT_DEFAULTS, type NodeRuntimeConfig } from "@mycli/config";
import { fingerprintSubmission } from "@mycli/core";
import { ProviderFailure, type ModelProvider } from "@mycli/providers";
import { openRuntimeSessionStore, projectTranscript, type RuntimeSessionStore } from "@mycli/storage";
import { CompactionCoordinator, type CompactionRuntimeEvent } from "../../src/context/compaction-coordinator.ts";
import { summarizeCompactionWithProvider } from "../../src/context/compaction-model-executor.ts";
import { CompactionModelJournal } from "../../src/context/compaction-model-journal.ts";

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

async function createFixture(t: test.TestContext, provider: ModelProvider, options: {
	readonly signal?: AbortSignal;
	readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
} = {}): Promise<{
	readonly root: string;
	readonly dbPath: string;
	readonly store: RuntimeSessionStore;
	readonly events: CompactionRuntimeEvent[];
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
	};
	const journal = new CompactionModelJournal({ sessionId: SESSION, store, clock: () => NOW });
	const events: CompactionRuntimeEvent[] = [];
	const coordinator = new CompactionCoordinator({
		sessionId: SESSION, workspaceRoot: root, threadId: SESSION, store,
		tokenLimit: 200, reservedOutputTokens: 20, tailTurns: 1, tailMaxTokens: 1000,
		summaryMaxTokens: 100, minSavingsRatio: 0, rehydrationMaxFiles: 0,
		rehydrationMaxItemTokens: 0, rehydrationMaxTotalTokens: 0,
		createCheckpointId: () => "checkpoint-summary", clock: () => NOW,
		recordModelEvent: (evidence) => journal.record(evidence),
		summarize: (input) => summarizeCompactionWithProvider(provider, config, input, {
			sleep: options.sleep ?? (async () => {}), random: () => 0, clock: () => NOW,
		}),
	});
	return { root, dbPath, store, events, compact: () => coordinator.compact({
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
