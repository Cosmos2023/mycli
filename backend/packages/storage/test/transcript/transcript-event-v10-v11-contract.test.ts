import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	SCHEMA_V10_VERSION,
	SCHEMA_V11_VERSION,
	SQLiteTranscriptEventRepository,
	TRANSCRIPT_EVENT_SCHEMA_VERSION,
	type TranscriptEventAppendInput,
} from "../../src/index.ts";

const NOW = "2026-08-14T00:00:00.000Z";
const LARGE_REPEATED_TEXT = "repeated compacted provider context\n".repeat(100);
const LARGE_ARGUMENTS = JSON.stringify({ input: LARGE_REPEATED_TEXT });

test("keeps v10/v11 provider, readable, compaction, lineage, recovery, and artifact parity", async (t) => {
	const v10 = await buildContractCorpus(t, SCHEMA_V10_VERSION);
	const v11 = await buildContractCorpus(t, SCHEMA_V11_VERSION);
	assert.deepEqual(v11.snapshot, v10.snapshot);
	assert.deepEqual(v11.snapshot.rootProvider, [
		{ type: "user", text: LARGE_REPEATED_TEXT },
		{ type: "user", text: "retry after rollback" },
	]);
	assert.deepEqual(v11.snapshot.pendingCalls, []);
	assert.ok(v11.snapshot.rootReadable.length > 3);
	assert.deepEqual(v11.snapshot.rootPaged, v11.snapshot.rootReadable);
	assert.deepEqual(v11.snapshot.branchPaged, v11.snapshot.branchReadable);

	const database = new Database(v11.dbPath, { readonly: true });
	try {
		const referenceCount = scalar(database, "SELECT COUNT(*) FROM transcript_event_blob_refs");
		const blobCount = scalar(database, "SELECT COUNT(*) FROM session_content_blobs");
		assert.ok(referenceCount >= 600);
		assert.ok(blobCount < referenceCount / 10);
		assert.equal(scalar(database, `
			SELECT COUNT(DISTINCT content.blob_id) FROM transcript_event_blob_refs AS reference
			JOIN session_content_blobs AS content ON content.blob_id = reference.blob_id
			WHERE content.raw_bytes = ?
		`, Buffer.byteLength(LARGE_REPEATED_TEXT, "utf8")), 1);
	} finally {
		database.close();
	}
});

interface ContractSnapshot {
	readonly rootProvider: readonly unknown[];
	readonly branchProvider: readonly unknown[];
	readonly rootReadable: readonly unknown[];
	readonly rootPaged: readonly unknown[];
	readonly branchReadable: readonly unknown[];
	readonly branchPaged: readonly unknown[];
	readonly pendingCalls: readonly unknown[];
	readonly contexts: readonly unknown[];
	readonly history: readonly unknown[];
	readonly rollouts: readonly unknown[];
	readonly summaries: readonly string[];
	readonly recentSummaries: readonly string[];
	readonly lineage: readonly unknown[];
	readonly sourceEvents: readonly unknown[];
}

async function buildContractCorpus(
	t: test.TestContext,
	version: typeof SCHEMA_V10_VERSION | typeof SCHEMA_V11_VERSION,
): Promise<Readonly<{ readonly dbPath: string; readonly snapshot: ContractSnapshot }>> {
	const root = await mkdtemp(join(tmpdir(), `mycli-transcript-contract-v${version}-`));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const dbPath = join(root, "sessions.db");
	let repository = new SQLiteTranscriptEventRepository({
		dbPath,
		initializeSchemaVersion: version,
		clock: () => NOW,
		processId: 900_001,
	});
	repository.reserveTurn({
		sessionId: "source",
		clientTurnId: "client-recovery",
		clientUserMessageId: "user-recovery",
		turnId: "turn-recovery",
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot: root,
		threadId: "source",
		userText: LARGE_REPEATED_TEXT,
		startedAt: NOW,
	});
	repository.appendAssistantToolCalls({
		sessionId: "source",
		clientTurnId: "client-recovery",
		assistantText: LARGE_REPEATED_TEXT,
		calls: [
			{ callId: "call-complete", name: "Read", argumentsJson: LARGE_ARGUMENTS },
			{ callId: "call-pending", name: "Grep", argumentsJson: LARGE_ARGUMENTS },
		],
	});
	repository.appendToolResult({
		sessionId: "source",
		clientTurnId: "client-recovery",
		result: {
			callId: "call-complete",
			toolName: "Read",
			output: LARGE_REPEATED_TEXT,
			success: true,
		},
		summary: "first tool completed",
	});
	repository.close();

	repository = new SQLiteTranscriptEventRepository({
		dbPath,
		clock: () => NOW,
		isProcessAlive: () => false,
	});
	const recoveredEvents = repository.loadTurnEventWindow(
		"source",
		"turn-recovery",
		{ limit: 100 },
	).events;
	assert.ok(recoveredEvents.some((event) => (
		event.eventType === "turn_lifecycle" && event.payload.phase === "interrupted"
	)));
	repository.reserveTurn({
		sessionId: "source",
		clientTurnId: "client-complete",
		clientUserMessageId: "user-complete",
		turnId: "turn-complete",
		requestFingerprint: `sha256:${"b".repeat(64)}`,
		workspaceRoot: root,
		threadId: "source",
		userText: "fork source request",
		startedAt: NOW,
	});
	repository.completeTurn({
		sessionId: "source",
		clientTurnId: "client-complete",
		assistantText: LARGE_REPEATED_TEXT,
		usage: {},
		completedAt: NOW,
	});
	const forkBoundary = repository.loadTurnEventWindow(
		"source",
		"turn-complete",
		{ limit: 100 },
	).events.find((event) => (
		event.eventType === "turn_lifecycle" && event.payload.phase === "completed"
	));
	assert.ok(forkBoundary);
	repository.forkSession({
		sourceSessionId: "source",
		targetSessionId: "branch",
		forkEventId: forkBoundary.eventId,
	});
	append(repository, "branch", "branch-user", "branch-turn", "user_input", {
		text: LARGE_REPEATED_TEXT,
		clientUserMessageId: "branch-user",
		source: "submit",
	}, true);
	append(repository, "branch", "branch-assistant", "branch-turn", "assistant_output", {
		text: "branch answer",
	}, true);

	const latestProvider = repository.loadEventWindow("source", { limit: 100 }).events
		.filter((event) => event.modelVisible).at(-1);
	assert.ok(latestProvider?.providerIndex !== undefined);
	for (let window = 1; window <= 300; window += 1) {
		append(repository, "source", `compact-${window}`, `compact-turn-${window}`, "compaction", {
			windowId: `window-${window}`,
			sourceProviderIndex: latestProvider.providerIndex,
			replacement: [{ type: "user", text: LARGE_REPEATED_TEXT }],
			summary: LARGE_REPEATED_TEXT,
		}, false);
	}
	append(repository, "source", "later-user", "turn-later", "user_input", {
		text: "discarded after compact",
		clientUserMessageId: "later-user",
		source: "submit",
	}, true);
	append(repository, "source", "later-assistant", "turn-later", "assistant_output", {
		text: "discarded answer",
	}, true);
	append(repository, "source", "rollback", "turn-later", "rollback", {
		removedTurnIds: ["turn-later"],
		boundaryEventId: "compact-300",
		reason: "retry",
	}, false);
	append(repository, "source", "retry-user", "turn-retry", "user_input", {
		text: "retry after rollback",
		clientUserMessageId: "retry-user",
		source: "submit",
	}, true);

	const rootReadable = repository.loadReadableTranscript("source");
	const branchReadable = repository.loadReadableTranscript("branch");
	const snapshot: ContractSnapshot = Object.freeze({
		rootProvider: repository.loadConversationItems("source"),
		branchProvider: repository.loadConversationItems("branch"),
		rootReadable,
		rootPaged: loadAllPages(repository, "source"),
		branchReadable,
		branchPaged: loadAllPages(repository, "branch"),
		pendingCalls: repository.loadPendingToolCalls("source", "turn-recovery"),
		contexts: repository.loadContextItems("source", "turn-recovery"),
		history: repository.loadHistoryItems("source"),
		rollouts: repository.loadTurnRollouts("source"),
		summaries: repository.loadSessionSummaries("source"),
		recentSummaries: repository.loadRecentSessionSummaries("source", 10),
		lineage: repository.loadSessionLineage("branch"),
		sourceEvents: repository.loadSourceEvents("source", [
			"compact-300",
			"retry-user",
		]),
	});
	repository.close();
	return Object.freeze({ dbPath, snapshot });
}

function append(
	repository: SQLiteTranscriptEventRepository,
	sessionId: string,
	eventId: string,
	turnId: string,
	eventType: string,
	payload: Readonly<Record<string, unknown>>,
	modelVisible: boolean,
): void {
	repository.appendEvent({
		schemaVersion: TRANSCRIPT_EVENT_SCHEMA_VERSION,
		sessionId,
		eventId,
		turnId,
		eventType,
		modelVisible,
		createdAt: NOW,
		payload,
	} as unknown as TranscriptEventAppendInput);
}

function loadAllPages(
	repository: SQLiteTranscriptEventRepository,
	sessionId: string,
): readonly unknown[] {
	const items: unknown[] = [];
	let beforeSequence: number | undefined;
	for (;;) {
		const page = repository.loadReadableTranscriptPage(sessionId, {
			...(beforeSequence === undefined ? {} : { beforeSequence }),
			limit: 75,
		});
		items.unshift(...page.items);
		if (page.nextBeforeSequence === null) return Object.freeze(items);
		beforeSequence = page.nextBeforeSequence;
	}
}

function scalar(database: Database.Database, sql: string, ...parameters: unknown[]): number {
	return Number(database.prepare(sql).pluck().get(...parameters));
}
