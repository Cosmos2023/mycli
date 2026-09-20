import { removeFixtureDirectoryAfterTests } from "../fixtures/directory-cleanup.ts";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	createV10SessionDatabase,
	SQLiteSessionStore,
	SQLiteTranscriptEventRepository,
	StorageFailure,
} from "../../src/index.ts";

const NOW = "2026-08-14T00:00:00.000Z";

test("creates the final schema-v10 transcript event shape without legacy transcript tables", async (t) => {
	const fixture = await databaseFixture(t);
	createV10SessionDatabase({ dbPath: fixture.dbPath });
	const database = new Database(fixture.dbPath);
	t.after(() => database.close());

	assert.equal((database.prepare("SELECT version FROM schema_version").get() as { version: number }).version, 10);
	const tables = objectNames(database, "table");
	assert.ok(tables.has("transcript_events"));
	assert.ok(tables.has("transcript_events_fts"));
	for (const legacy of [
		"conversation_messages",
		"history_items",
		"turn_rollouts",
		"session_summaries",
		"conversation_messages_fts",
		"history_items_fts",
	]) {
		assert.equal(tables.has(legacy), false);
	}
	assert.deepEqual(
		(database.prepare("PRAGMA table_info(transcript_events)").all() as readonly { name: string }[])
			.map((column) => column.name),
		[
			"sequence_no",
			"session_id",
			"event_id",
			"turn_id",
			"event_type",
			"provider_index",
			"model_visible",
			"payload_json",
			"created_at",
		],
	);
	const indexes = objectNames(database, "index");
	for (const index of [
		"idx_transcript_events_session_sequence",
		"idx_transcript_events_session_turn_sequence",
		"idx_transcript_events_session_provider",
		"idx_transcript_events_session_type_sequence",
	]) {
		assert.ok(indexes.has(index), index);
	}
	assert.deepEqual(
		(database.prepare("PRAGMA table_info(conversation_trees)").all() as readonly { name: string }[])
			.map((column) => column.name),
		["session_id", "parent_id", "fork_point", "updated_at", "fork_event_session_id", "fork_event_id"],
	);
	assert.ok(indexes.has("idx_conversation_trees_parent_event"));
});

test("enforces event identity/provider uniqueness, model visibility, payload shape, and append-only rows", async (t) => {
	const fixture = await databaseFixture(t);
	createV10SessionDatabase({ dbPath: fixture.dbPath });
	const database = new Database(fixture.dbPath);
	t.after(() => database.close());
	seedSession(database);
	insertEvent(database, {
		eventId: "event-1",
		eventType: "user_input",
		providerIndex: 0,
		modelVisible: 1,
		payload: { text: "hello", clientUserMessageId: "user-1", source: "submit" },
	});

	assert.throws(() => insertEvent(database, {
		eventId: "event-1",
		eventType: "user_input",
		providerIndex: 1,
		modelVisible: 1,
		payload: { text: "duplicate id", clientUserMessageId: "user-2", source: "submit" },
	}), /UNIQUE constraint failed/u);
	assert.throws(() => insertEvent(database, {
		eventId: "event-2",
		eventType: "assistant_output",
		providerIndex: 0,
		modelVisible: 1,
		payload: { text: "duplicate provider index" },
	}), /UNIQUE constraint failed/u);
	assert.throws(() => insertEvent(database, {
		eventId: "event-3",
		eventType: "display_activity",
		providerIndex: null,
		modelVisible: 1,
		payload: { activityType: "status", text: "invalid visibility" },
	}), /CHECK constraint failed/u);
	assert.throws(() => database.prepare(`
		INSERT INTO transcript_events (
			session_id, event_id, turn_id, event_type, provider_index,
			model_visible, payload_json, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).run("session-1", "event-bad-json", "turn-1", "user_input", 2, 1, "{}", NOW), /CHECK constraint failed/u);
	assert.throws(
		() => database.prepare("UPDATE transcript_events SET created_at = ?").run(NOW),
		/append-only/u,
	);
	assert.throws(
		() => database.prepare("DELETE FROM transcript_events").run(),
		/append-only/u,
	);
});

test("keeps external-content event FTS synchronized for searchable insert, update, and delete", async (t) => {
	const fixture = await databaseFixture(t);
	createV10SessionDatabase({ dbPath: fixture.dbPath });
	const database = new Database(fixture.dbPath);
	t.after(() => database.close());
	seedSession(database);
	insertEvent(database, {
		eventId: "searchable",
		eventType: "user_input",
		providerIndex: 0,
		modelVisible: 1,
		payload: { text: "alphaxuniqueterm", clientUserMessageId: "user-1", source: "submit" },
	});
	insertEvent(database, {
		eventId: "hidden",
		eventType: "display_activity",
		providerIndex: null,
		modelVisible: 0,
		payload: { activityType: "status", text: "hiddenxuniqueterm" },
	});
	insertEvent(database, {
		eventId: "hidden-model-event",
		eventType: "user_input",
		providerIndex: null,
		modelVisible: 0,
		payload: {
			text: "internalxuniqueterm",
			clientUserMessageId: "internal-1",
			source: "agent_mailbox",
		},
	});
	assert.equal(matchCount(database, "alphaxuniqueterm"), 1);
	assert.equal(matchCount(database, "hiddenxuniqueterm"), 0);
	assert.equal(matchCount(database, "internalxuniqueterm"), 0);

	database.exec("DROP TRIGGER transcript_events_no_update");
	database.exec("DROP TRIGGER transcript_events_no_delete");
	database.prepare(`
		UPDATE transcript_events SET payload_json = ? WHERE event_id = ?
	`).run(storedPayload({
		text: "betaxuniqueterm",
		clientUserMessageId: "user-1",
		source: "submit",
	}), "searchable");
	assert.equal(matchCount(database, "alphaxuniqueterm"), 0);
	assert.equal(matchCount(database, "betaxuniqueterm"), 1);
	database.prepare("DELETE FROM transcript_events WHERE event_id = ?").run("searchable");
	assert.equal(matchCount(database, "betaxuniqueterm"), 0);
});

test("loads typed events from v10 while the v9-only store rejects the marker without writes", async (t) => {
	const fixture = await databaseFixture(t);
	createV10SessionDatabase({ dbPath: fixture.dbPath });
	const database = new Database(fixture.dbPath);
	seedSession(database);
	insertEvent(database, {
		eventId: "event-1",
		eventType: "assistant_output",
		providerIndex: 0,
		modelVisible: 1,
		payload: { text: "complete" },
	});
	database.close();
	const repository = new SQLiteTranscriptEventRepository({ dbPath: fixture.dbPath });
	t.after(() => repository.close());
	const event = repository.loadEvent("session-1", "event-1");
	assert.equal(event?.eventType, "assistant_output");
	if (event?.eventType !== "assistant_output") assert.fail("expected assistant output");
	assert.equal(event.payload.text, "complete");

	assert.throws(
		() => new SQLiteSessionStore({ dbPath: fixture.dbPath }),
		(error: unknown) => error instanceof StorageFailure
			&& error.diagnostics.expected_version === 9
			&& error.diagnostics.actual_version === 10,
	);
	const inspection = new Database(fixture.dbPath, { readonly: true });
	t.after(() => inspection.close());
	const version = inspection.prepare(
		"SELECT version FROM schema_version",
	).pluck().get();
	assert.equal(version, 10);
});

test("does not initialize v10 over an existing database with a missing version marker", async (t) => {
	const fixture = await databaseFixture(t);
	const database = new Database(fixture.dbPath);
	database.exec("CREATE TABLE legacy_private_data (payload TEXT NOT NULL)");
	database.prepare("INSERT INTO legacy_private_data (payload) VALUES (?)").run("preserve-me");
	database.close();

	assert.throws(
		() => new SQLiteTranscriptEventRepository({ dbPath: fixture.dbPath }),
		(error: unknown) => error instanceof StorageFailure
			&& error.message === "persistence_error: session schema version marker is invalid",
	);
	const check = new Database(fixture.dbPath, { readonly: true });
	t.after(() => check.close());
	assert.equal(check.prepare("SELECT payload FROM legacy_private_data").pluck().get(), "preserve-me");
	assert.equal(objectNames(check, "table").has("transcript_events"), false);
});

function seedSession(database: Database.Database): void {
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at, updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run("session-1", "/workspace", "thread-1", NOW, NOW, NOW, "active");
}

function insertEvent(database: Database.Database, input: Readonly<{
	readonly eventId: string;
	readonly eventType: string;
	readonly providerIndex: number | null;
	readonly modelVisible: 0 | 1;
	readonly payload: Readonly<Record<string, unknown>>;
}>): void {
	database.prepare(`
		INSERT INTO transcript_events (
			session_id, event_id, turn_id, event_type, provider_index,
			model_visible, payload_json, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		"session-1",
		input.eventId,
		"turn-1",
		input.eventType,
		input.providerIndex,
		input.modelVisible,
		storedPayload(input.payload),
		NOW,
	);
}

function storedPayload(payload: Readonly<Record<string, unknown>>): string {
	return JSON.stringify({ schemaVersion: 1, payload });
}

function matchCount(database: Database.Database, query: string): number {
	return Number((database.prepare(`
		SELECT COUNT(*) FROM transcript_events_fts WHERE transcript_events_fts MATCH ?
	`).pluck().get(query)) ?? 0);
}

function objectNames(database: Database.Database, type: "table" | "index"): ReadonlySet<string> {
	return new Set((database.prepare(`
		SELECT name FROM sqlite_master WHERE type = ?
	`).all(type) as readonly { name: string }[]).map((row) => row.name));
}

async function databaseFixture(t: test.TestContext): Promise<{
	readonly root: string;
	readonly dbPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-v10-schema-"));
	removeFixtureDirectoryAfterTests(t, root);
	return { root, dbPath: join(root, "sessions.db") };
}
