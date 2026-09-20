import { removeFixtureDirectoryAfterTests } from "../fixtures/directory-cleanup.ts";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	SCHEMA_V11_VERSION,
	SQLiteTranscriptEventRepository,
	StorageFailure,
	TRANSCRIPT_EVENT_SCHEMA_VERSION,
	type TranscriptEventAppendInput,
} from "../../src/index.ts";

const NOW = "2026-08-14T00:00:00.000Z";
const LARGE_SHARED_TEXT = "shared externalized transcript value\n".repeat(100);
const LARGE_IMAGE_DATA = Buffer.alloc(1_200, 0x61).toString("base64");
const LARGE_ARGUMENTS = JSON.stringify({ input: LARGE_SHARED_TEXT, repeated: LARGE_SHARED_TEXT });
const CONTEXT_METADATA = Object.freeze({
	kind: "workspace_instructions" as const,
	role: "developer" as const,
	cacheClass: "static" as const,
	durability: "persistent" as const,
	scope: "session" as const,
	sourceId: "content-blob-test",
	contentSha256: "a".repeat(64),
	contentLength: LARGE_SHARED_TEXT.length,
});

test("externalizes every eligible event field and hydrates all transcript read paths exactly", async (t) => {
	const fixture = await repositoryFixture(t, "round-trip");
	const inputs = eventCorpus();
	const appended = inputs.map((input) => fixture.repository.appendEvent(input));

	const database = new Database(fixture.dbPath, { readonly: true });
	t.after(() => database.close());
	const storedPayloads = (database.prepare(`
		SELECT payload_json FROM transcript_events ORDER BY sequence_no
	`).all() as readonly { readonly payload_json: string }[]).map((row) => row.payload_json);
	assert.ok(storedPayloads.every((payload) => (
		!payload.includes("shared externalized transcript value")
	)));
	assert.ok(storedPayloads.every((payload) => !payload.includes(LARGE_IMAGE_DATA)));
	assert.ok(storedPayloads.some((payload) => payload.includes("user-small-id")));
	assert.ok(storedPayloads.some((payload) => payload.includes("rollback-small-id")));
	const referenceCount = scalar(database, "SELECT COUNT(*) FROM transcript_event_blob_refs");
	const contentCount = scalar(database, "SELECT COUNT(*) FROM session_content_blobs");
	assert.ok(referenceCount >= 15);
	assert.ok(contentCount < referenceCount);

	for (const expected of appended) {
		assert.deepEqual(
			fixture.repository.loadEvent(expected.sessionId, expected.eventId),
			expected,
		);
	}
	assert.deepEqual(
		fixture.repository.loadEventWindow("session-1", { limit: 100 }).events,
		appended,
	);
	assert.deepEqual(
		fixture.repository.loadTurnEventWindow("session-1", "turn-1", { limit: 100 }).events,
		appended,
	);
	assert.deepEqual(
		fixture.repository.loadSourceEvents("session-1", ["event-context", "event-user"]),
		[appended[4], appended[0]],
	);
	assert.deepEqual(fixture.repository.loadLatestCompaction("session-1"), appended[8]);
	assert.equal(fixture.repository.loadContextItems("session-1")[0]?.text, LARGE_SHARED_TEXT);
	assert.deepEqual(fixture.repository.loadSessionSummaries("session-1"), [LARGE_SHARED_TEXT]);
	assert.ok(JSON.stringify(fixture.repository.loadConversationItems("session-1"))
		.includes("shared externalized transcript value"));
	assert.ok(JSON.stringify(fixture.repository.loadReadableTranscript("session-1"))
		.includes("shared externalized transcript value"));
	assert.ok(JSON.stringify(fixture.repository.loadRecentReadableTranscript("session-1"))
		.includes("shared externalized transcript value"));
	assert.ok(JSON.stringify(fixture.repository.loadReadableTranscriptPage(
		"session-1",
		{ limit: 100 },
	).items).includes("shared externalized transcript value"));
	assert.ok(JSON.stringify(fixture.repository.loadHistoryItems("session-1"))
		.includes("shared externalized transcript value"));
	assert.equal(fixture.repository.searchMessages("externalized").length > 0, true);

	fixture.repository.close();
	const reopened = new SQLiteTranscriptEventRepository({ dbPath: fixture.dbPath });
	t.after(() => reopened.close());
	assert.deepEqual(reopened.loadEventWindow("session-1", { limit: 100 }).events, appended);
});

test("rolls back blobs, event, references, and FTS when externalized append fails", async (t) => {
	const fixture = await repositoryFixture(t, "rollback");
	const database = new Database(fixture.dbPath);
	database.exec(`
		CREATE TRIGGER fail_transcript_blob_reference
		BEFORE INSERT ON transcript_event_blob_refs BEGIN
			SELECT RAISE(ABORT, 'private injected reference failure');
		END
	`);
	database.close();
	const input = event("assistant_output", "private-event-id", {
		text: "private rollback content\n".repeat(100),
	}, true);
	assert.throws(
		() => fixture.repository.appendEvent(input),
		(error: unknown) => error instanceof StorageFailure
			&& !error.message.includes("private-event-id")
			&& !error.message.includes("private rollback content")
			&& !JSON.stringify(error.diagnostics).includes("private-event-id"),
	);

	const inspect = new Database(fixture.dbPath, { readonly: true });
	t.after(() => inspect.close());
	assert.equal(scalar(inspect, "SELECT COUNT(*) FROM session_content_blobs"), 0);
	assert.equal(scalar(inspect, "SELECT COUNT(*) FROM transcript_events"), 0);
	assert.equal(scalar(inspect, "SELECT COUNT(*) FROM transcript_event_blob_refs"), 0);
	assert.equal(scalar(inspect, "SELECT COUNT(*) FROM transcript_events_fts"), 0);
});

test("keeps schema v10 payloads inline", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "mycli-content-blob-v10-"));
	removeFixtureDirectoryAfterTests(t, root);
	const dbPath = join(root, "sessions.db");
	const repository = new SQLiteTranscriptEventRepository({ dbPath });
	t.after(() => repository.close());
	seedSession(dbPath);
	repository.appendEvent(event("assistant_output", "event-v10", {
		text: LARGE_SHARED_TEXT,
	}, true));
	const database = new Database(dbPath, { readonly: true });
	t.after(() => database.close());
	const stored = JSON.parse(String(database.prepare(`
		SELECT payload_json FROM transcript_events WHERE event_id = 'event-v10'
	`).pluck().get())) as { readonly payload: { readonly text: string } };
	assert.equal(stored.payload.text, LARGE_SHARED_TEXT);
	assert.equal(database.prepare(`
		SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_content_blobs'
	`).get(), undefined);
});

function eventCorpus(): readonly TranscriptEventAppendInput[] {
	return Object.freeze([
		event("user_input", "event-user", {
			text: LARGE_SHARED_TEXT,
			clientUserMessageId: "user-small-id",
			source: "submit",
			images: [{ mediaType: "image/png", data: LARGE_IMAGE_DATA }],
		}, true),
		event("assistant_output", "event-assistant", {
			text: LARGE_SHARED_TEXT,
			providerState: { provider: "openai", value: { signature: LARGE_SHARED_TEXT } },
		}, true),
		event("assistant_tool_call_batch", "event-tool-batch", {
			text: LARGE_SHARED_TEXT,
			calls: [
				{ callId: "call-1", name: "Read", argumentsJson: LARGE_ARGUMENTS },
				{ callId: "call-2", name: "Grep", argumentsJson: LARGE_ARGUMENTS },
			],
		}, true),
		event("tool_result", "event-tool-result", {
			result: {
				callId: "call-1",
				toolName: "Read",
				images: [{ mediaType: "image/png", data: LARGE_IMAGE_DATA, detail: "original" }],
				output: LARGE_SHARED_TEXT,
				success: true,
			},
			summary: "small tool summary",
			metadata: { retained: LARGE_SHARED_TEXT },
		}, true),
		event("context", "event-context", {
			itemId: "context-small-id",
			text: LARGE_SHARED_TEXT,
			metadata: CONTEXT_METADATA,
		}, true),
		event("display_activity", "event-display", {
			activityType: "reasoning",
			text: LARGE_SHARED_TEXT,
			metadata: { detail: LARGE_SHARED_TEXT },
		}, false),
		event("turn_lifecycle", "event-lifecycle", {
			phase: "completed",
			message: LARGE_SHARED_TEXT,
			diagnostics: { detail: LARGE_SHARED_TEXT },
		}, false),
		event("rollback", "event-rollback", {
			removedTurnIds: ["rollback-small-id"],
			reason: "retry",
		}, false),
		event("compaction", "event-compaction", {
			windowId: "window-small-id",
			sourceProviderIndex: 4,
			replacement: [{ type: "user", text: LARGE_SHARED_TEXT }],
			summary: LARGE_SHARED_TEXT,
			metadata: { detail: LARGE_SHARED_TEXT },
		}, false),
		event("opaque_legacy", "event-opaque", {
			sourceKind: "session_summaries",
			sourceIdentity: "opaque-small-id",
			rawPayload: LARGE_SHARED_TEXT,
			errorCode: "invalid_shape",
		}, false),
	]);
}

function event(
	eventType: string,
	eventId: string,
	payload: Readonly<Record<string, unknown>>,
	modelVisible: boolean,
): TranscriptEventAppendInput {
	return {
		schemaVersion: TRANSCRIPT_EVENT_SCHEMA_VERSION,
		sessionId: "session-1",
		eventId,
		turnId: "turn-1",
		eventType,
		modelVisible,
		createdAt: NOW,
		payload,
	} as never;
}

async function repositoryFixture(
	t: test.TestContext,
	name: string,
): Promise<{
	readonly dbPath: string;
	readonly repository: SQLiteTranscriptEventRepository;
}> {
	const root = await mkdtemp(join(tmpdir(), `mycli-event-content-blobs-${name}-`));
	removeFixtureDirectoryAfterTests(t, root);
	const dbPath = join(root, "sessions.db");
	const repository = new SQLiteTranscriptEventRepository({
		dbPath,
		initializeSchemaVersion: SCHEMA_V11_VERSION,
		clock: () => NOW,
	});
	t.after(() => repository.close());
	seedSession(dbPath);
	return { dbPath, repository };
}

function seedSession(dbPath: string): void {
	const database = new Database(dbPath);
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at, updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, 'active')
	`).run("session-1", "/workspace", "session-1", NOW, NOW, NOW);
	database.close();
}

function scalar(database: Database.Database, sql: string): number {
	return Number(database.prepare(sql).pluck().get());
}
