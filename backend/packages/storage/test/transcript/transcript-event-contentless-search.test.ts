import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	SCHEMA_V10_VERSION,
	SCHEMA_V11_VERSION,
	SQLiteTranscriptEventRepository,
	StorageFailure,
	TRANSCRIPT_EVENT_SCHEMA_VERSION,
	type SessionSearchResult,
	type TranscriptEventAppendInput,
} from "../../src/index.ts";

const NOW = "2026-08-14T00:00:00.000Z";
const WORKSPACE = "/workspace/a";
const OTHER_WORKSPACE = "/workspace/b";
const SEARCH_TEXT = `${"prefix ".repeat(180)}Alpha.beta externalized repository marker ${
	"suffix ".repeat(180)
}`;

test("keeps v10/v11 contentless search sets, rank, lineage, and snippets equivalent", async (t) => {
	const v10 = await searchCorpus(t, SCHEMA_V10_VERSION);
	const v11 = await searchCorpus(t, SCHEMA_V11_VERSION);
	const query = "Alpha.beta externalized repository";
	const v10Results = v10.repository.searchMessages(query, { workspaceRoot: WORKSPACE, limit: 100 });
	const v11Results = v11.repository.searchMessages(query, { workspaceRoot: WORKSPACE, limit: 100 });
	assert.deepEqual(comparable(v11Results), comparable(v10Results));
	assert.ok(v11Results.some((result) => result.sessionId === "parent"));
	assert.ok(v11Results.some((result) => result.sessionId === "branch"));
	assert.ok(v11Results.every((result) => result.snippet.length <= 160));
	assert.ok(v11Results.some((result) => result.snippet.includes("Alpha.beta externalized")));
	assert.equal(v11.repository.searchMessages(query, {
		workspaceRoot: OTHER_WORKSPACE,
		limit: 100,
	}).length, 1);

	const rankedV10 = v10.repository.searchMessages("rankneedle", {
		workspaceRoot: WORKSPACE,
		limit: 20,
	});
	const rankedV11 = v11.repository.searchMessages("rankneedle", {
		workspaceRoot: WORKSPACE,
		limit: 20,
	});
	assert.deepEqual(comparable(rankedV11), comparable(rankedV10));
	assert.equal(rankedV11[0]?.snippet.match(/rankneedle/gu)?.length, 10);

	const database = new Database(v11.dbPath);
	const indexedColumn = database.prepare(`
		SELECT payload_json FROM transcript_events_fts LIMIT 1
	`).pluck().get();
	assert.equal(indexedColumn, null);
	const sequenceNo = Number(database.prepare(`
		SELECT sequence_no FROM transcript_events
		WHERE session_id = 'parent' AND event_type = 'user_input'
		ORDER BY sequence_no LIMIT 1
	`).pluck().get());
	database.prepare("DELETE FROM transcript_events_fts WHERE rowid = ?").run(sequenceNo);
	assert.ok(v11.repository.searchMessages(query, {
		workspaceRoot: WORKSPACE,
		limit: 100,
	}).length < v11Results.length);
	v11.repository.rebuildSearchIndex();
	assert.deepEqual(
		comparable(v11.repository.searchMessages(query, { workspaceRoot: WORKSPACE, limit: 100 })),
		comparable(v11Results),
	);
	database.prepare("DELETE FROM transcript_events_fts").run();
	assert.deepEqual(v11.repository.searchMessages(query, { workspaceRoot: WORKSPACE }), []);
	v11.repository.rebuildSearchIndex();
	assert.deepEqual(
		comparable(v11.repository.searchMessages(query, { workspaceRoot: WORKSPACE, limit: 100 })),
		comparable(v11Results),
	);
	database.close();

	v10.repository.rebuildSearchIndex();
	assert.deepEqual(
		comparable(v10.repository.searchMessages(query, { workspaceRoot: WORKSPACE, limit: 100 })),
		comparable(v10Results),
	);
});

test("rejects a search hit whose externalized content is corrupt without exposing identity", async (t) => {
	const fixture = await searchCorpus(t, SCHEMA_V11_VERSION);
	append(fixture.repository, "parent", "corrupt-search", "corrupt-turn", "assistant_output", {
		text: `${"corruptsearchneedle ".repeat(100)}private searchable bytes`,
	}, true);
	const database = new Database(fixture.dbPath);
	const row = database.prepare(`
		SELECT content.blob_id, content.stored_bytes
		FROM transcript_events AS events
		JOIN transcript_event_blob_refs AS reference
		  ON reference.sequence_no = events.sequence_no
		JOIN session_content_blobs AS content ON content.blob_id = reference.blob_id
		WHERE events.event_id = 'corrupt-search' AND reference.json_pointer = '/payload/text'
	`).get() as { readonly blob_id: string; readonly stored_bytes: number };
	database.exec("DROP TRIGGER session_content_blobs_no_update");
	database.prepare(`
		UPDATE session_content_blobs SET payload_blob = ? WHERE blob_id = ?
	`).run(randomBytes(row.stored_bytes), row.blob_id);
	database.close();

	assert.throws(
		() => fixture.repository.searchMessages("corruptsearchneedle", {
			workspaceRoot: WORKSPACE,
		}),
		(error: unknown) => error instanceof StorageFailure
			&& !error.message.includes(row.blob_id)
			&& !error.message.includes("private searchable bytes")
			&& !JSON.stringify(error.diagnostics).includes(row.blob_id),
	);
});

async function searchCorpus(
	t: test.TestContext,
	version: typeof SCHEMA_V10_VERSION | typeof SCHEMA_V11_VERSION,
): Promise<Readonly<{
	readonly dbPath: string;
	readonly repository: SQLiteTranscriptEventRepository;
}>> {
	const root = await mkdtemp(join(tmpdir(), `mycli-contentless-search-v${version}-`));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const dbPath = join(root, "sessions.db");
	const repository = new SQLiteTranscriptEventRepository({
		dbPath,
		initializeSchemaVersion: version,
		clock: () => NOW,
	});
	t.after(() => repository.close());
	repository.reserveTurn({
		sessionId: "parent",
		clientTurnId: "parent-client",
		clientUserMessageId: "parent-user-id",
		turnId: "parent-turn",
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot: WORKSPACE,
		threadId: "parent",
		userText: SEARCH_TEXT,
		startedAt: NOW,
	});
	repository.completeTurn({
		sessionId: "parent",
		clientTurnId: "parent-client",
		assistantText: `Assistant saw ${SEARCH_TEXT}`,
		usage: {},
		completedAt: NOW,
	});
	const boundary = repository.loadTurnEventWindow("parent", "parent-turn", { limit: 20 })
		.events.find((event) => event.eventType === "turn_lifecycle"
			&& event.payload.phase === "completed");
	assert.ok(boundary);
	repository.forkSession({
		sourceSessionId: "parent",
		targetSessionId: "branch",
		forkEventId: boundary.eventId,
	});
	append(repository, "branch", "branch-assistant", "branch-turn", "assistant_output", {
		text: `Branch ${SEARCH_TEXT}`,
	}, true);
	append(repository, "parent", "rank-low", "rank-low-turn", "assistant_output", {
		text: `rankneedle ${"low filler ".repeat(100)}`,
	}, true);
	append(repository, "parent", "rank-high", "rank-high-turn", "assistant_output", {
		text: `${"rankneedle ".repeat(10)}${"high filler ".repeat(100)}`,
	}, true);
	const database = new Database(dbPath);
	seedSession(database, "other", OTHER_WORKSPACE);
	database.close();
	append(repository, "other", "other-user", "other-turn", "user_input", {
		text: SEARCH_TEXT,
		clientUserMessageId: "other-user",
		source: "submit",
	}, true);
	return Object.freeze({ dbPath, repository });
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

function seedSession(
	database: Database.Database,
	sessionId: string,
	workspaceRoot: string,
): void {
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at, updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, 'active')
	`).run(sessionId, workspaceRoot, sessionId, NOW, NOW, NOW);
}

function comparable(results: readonly SessionSearchResult[]): readonly unknown[] {
	return results.map((result) => ({
		sessionId: result.sessionId,
		messageIndex: result.messageIndex,
		role: result.role,
		snippet: result.snippet,
	}));
}
