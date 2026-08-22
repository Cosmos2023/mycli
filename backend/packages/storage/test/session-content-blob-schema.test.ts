import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	analyzeV10ContentBlobs,
	createV11SessionDatabase,
	encodeSessionContentBlob,
	SQLiteSessionStore,
	StorageFailure,
} from "../src/index.ts";

const NOW = "2026-08-14T00:00:00.000Z";

test("creates schema v11 content, reference, and contentless FTS objects", async (t) => {
	const fixture = await databaseFixture(t);
	createV11SessionDatabase({ dbPath: fixture.dbPath });
	const database = new Database(fixture.dbPath);
	database.pragma("foreign_keys = ON");
	t.after(() => database.close());

	assert.equal(database.prepare("SELECT version FROM schema_version").pluck().get(), 11);
	const tables = objectNames(database, "table");
	for (const table of [
		"session_content_blobs",
		"transcript_event_blob_refs",
		"model_input_blob_refs",
		"transcript_events",
		"transcript_events_fts",
	]) assert.ok(tables.has(table), table);
	const indexes = objectNames(database, "index");
	for (const index of [
		"idx_session_content_blobs_codec",
		"idx_transcript_event_blob_refs_blob",
		"idx_model_input_blob_refs_content",
	]) assert.ok(indexes.has(index), index);
	const ftsSql = String(database.prepare(`
		SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transcript_events_fts'
	`).pluck().get());
	assert.match(ftsSql, /content=''/u);
	assert.match(ftsSql, /contentless_delete=1/u);
	assert.equal(database.prepare(`
		SELECT COUNT(*) FROM sqlite_master
		WHERE type = 'trigger' AND name LIKE 'transcript_events_fts_%'
	`).pluck().get(), 0);
});

test("enforces immutable blobs, reference foreign keys, and contentless deletion", async (t) => {
	const fixture = await databaseFixture(t);
	createV11SessionDatabase({ dbPath: fixture.dbPath });
	const database = new Database(fixture.dbPath);
	database.pragma("foreign_keys = ON");
	t.after(() => database.close());
	seedSession(database);
	const blob = encodeSessionContentBlob("large".repeat(1_000));
	database.prepare(`
		INSERT INTO session_content_blobs (
			blob_id, codec, raw_bytes, stored_bytes, payload_blob, created_at
		) VALUES (?, ?, ?, ?, ?, ?)
	`).run(blob.blobId, blob.codec, blob.rawBytes, blob.storedBytes, blob.payload, NOW);
	const event = database.prepare(`
		INSERT INTO transcript_events (
			session_id, event_id, turn_id, event_type, provider_index,
			model_visible, payload_json, created_at
		) VALUES (?, ?, ?, 'assistant_output', 0, 1, ?, ?)
	`).run(
		"session-1",
		"event-1",
		"turn-1",
		JSON.stringify({ schemaVersion: 1, payload: { text: null } }),
		NOW,
	);
	const sequenceNo = Number(event.lastInsertRowid);
	database.prepare(`
		INSERT INTO transcript_event_blob_refs (sequence_no, json_pointer, blob_id)
		VALUES (?, '/payload/text', ?)
	`).run(sequenceNo, blob.blobId);
	database.prepare(`
		INSERT INTO model_input_blobs (blob_id, payload_json, created_at) VALUES (?, ?, ?)
	`).run("model-blob", '{"schemaVersion":1}', NOW);
	database.prepare(`
		INSERT INTO model_input_blob_refs (blob_id, content_blob_id) VALUES (?, ?)
	`).run("model-blob", blob.blobId);

	assert.throws(
		() => database.prepare("UPDATE session_content_blobs SET created_at = ?").run(NOW),
		/immutable/u,
	);
	assert.throws(
		() => database.prepare("DELETE FROM session_content_blobs WHERE blob_id = ?").run(blob.blobId),
		/FOREIGN KEY constraint failed/u,
	);
	assert.throws(
		() => database.prepare(`
			INSERT INTO transcript_event_blob_refs (sequence_no, json_pointer, blob_id)
			VALUES (?, '/payload/missing', ?)
		`).run(sequenceNo, `sha256:${"0".repeat(64)}`),
		/FOREIGN KEY constraint failed/u,
	);

	database.prepare(`
		INSERT INTO transcript_events_fts(rowid, payload_json) VALUES (?, ?)
	`).run(sequenceNo, "searchableuniqueterm");
	assert.equal(database.prepare(`
		SELECT COUNT(*) FROM transcript_events_fts WHERE transcript_events_fts MATCH 'searchableuniqueterm'
	`).pluck().get(), 1);
	database.prepare("DELETE FROM transcript_events_fts WHERE rowid = ?").run(sequenceNo);
	assert.equal(database.prepare(`
		SELECT COUNT(*) FROM transcript_events_fts WHERE transcript_events_fts MATCH 'searchableuniqueterm'
	`).pluck().get(), 0);
});

test("schema-v10 and v9-only readers reject marker 11 without writes", async (t) => {
	const fixture = await databaseFixture(t);
	createV11SessionDatabase({ dbPath: fixture.dbPath });
	assert.throws(
		() => analyzeV10ContentBlobs({ dbPath: fixture.dbPath }),
		(error: unknown) => error instanceof StorageFailure
			&& error.diagnostics.expected_version === 10
			&& error.diagnostics.actual_version === 11,
	);
	assert.throws(
		() => new SQLiteSessionStore({ dbPath: fixture.dbPath }),
		(error: unknown) => error instanceof StorageFailure
			&& error.diagnostics.expected_version === 9
			&& error.diagnostics.actual_version === 11,
	);
	const database = new Database(fixture.dbPath, { readonly: true });
	assert.equal(database.prepare("SELECT version FROM schema_version").pluck().get(), 11);
	database.close();
});

function seedSession(database: Database.Database): void {
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at, updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, 'active')
	`).run("session-1", "/workspace", "session-1", NOW, NOW, NOW);
}

function objectNames(database: Database.Database, type: "table" | "index"): ReadonlySet<string> {
	return new Set((database.prepare(`
		SELECT name FROM sqlite_master WHERE type = ?
	`).all(type) as readonly { readonly name: string }[]).map((row) => row.name));
}

async function databaseFixture(t: test.TestContext): Promise<{
	readonly root: string;
	readonly dbPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-v11-schema-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return { root, dbPath: join(root, "sessions.db") };
}
