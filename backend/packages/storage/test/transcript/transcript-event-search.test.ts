import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	parseTranscriptEventAppendInput,
	SQLiteSessionStore,
	SQLiteTranscriptEventRepository,
	TRANSCRIPT_EVENT_SCHEMA_VERSION,
	type SessionSearchResult,
} from "../../src/index.ts";

const NOW = "2026-08-14T00:00:00.000Z";
const WORKSPACE = "/workspace/a";
const OTHER_WORKSPACE = "/workspace/b";

test("matches v9 search results with workspace filtering, punctuation, and legacy indices", async (t) => {
	const fixture = await databaseFixture(t);
	const legacyStore = seedLegacySearchDatabase(fixture.v9Path);
	t.after(() => legacyStore.close());
	const eventStore = new SQLiteTranscriptEventRepository({ dbPath: fixture.v10Path });
	t.after(() => eventStore.close());
	seedEventSessions(fixture.v10Path);

	const longPrefix = "prefix ".repeat(40);
	const userText = `${longPrefix}Alpha.beta repository marker ${"suffix ".repeat(40)}`;
	const assistantText = "Assistant saw Alpha.beta repository marker.";
	append(eventStore, "session-a", "user-a", "user_input", {
		text: userText,
		clientUserMessageId: "user-a",
		source: "submit",
	});
	append(eventStore, "session-a", "assistant-a", "assistant_output", {
		text: assistantText,
	});
	append(eventStore, "session-b", "user-b", "user_input", {
		text: "Alpha.beta repository marker in another workspace",
		clientUserMessageId: "user-b",
		source: "submit",
	});

	const query = "Alpha.beta repository";
	const legacyResults = legacyStore.searchMessages(query, {
		workspaceRoot: WORKSPACE,
		limit: 20,
	});
	const eventResults = eventStore.searchMessages(query, {
		workspaceRoot: WORKSPACE,
		limit: 20,
	});

	assert.deepEqual(comparable(eventResults), comparable(legacyResults));
	assert.deepEqual(eventResults.map((result) => result.messageIndex).sort(), [0, 1]);
	assert.ok(eventResults.every((result) => result.sessionId === "session-a"));
	assert.ok(eventResults.every((result) => result.snippet.length <= 160));
	assert.ok(eventResults.some((result) => result.snippet.includes("Alpha.beta repository")));
	assert.equal(eventStore.searchMessages(query, { workspaceRoot: OTHER_WORKSPACE }).length, 1);
	assert.deepEqual(eventStore.searchMessages("   "), []);
	assert.deepEqual(eventStore.searchMessages(query, { limit: 0 }), []);
});

test("keeps event search synchronized across insert, compatibility update, and delete", async (t) => {
	const fixture = await databaseFixture(t);
	const repository = new SQLiteTranscriptEventRepository({ dbPath: fixture.v10Path });
	t.after(() => repository.close());
	seedEventSessions(fixture.v10Path);
	append(repository, "session-a", "mutable", "user_input", {
		text: "insertxsearchterm",
		clientUserMessageId: "mutable-user",
		source: "submit",
	});
	assert.equal(repository.searchMessages("insertxsearchterm").length, 1);

	const database = new Database(fixture.v10Path);
	t.after(() => database.close());
	database.exec(`
		DROP TRIGGER transcript_events_no_update;
		DROP TRIGGER transcript_events_no_delete;
	`);
	database.prepare(`
		UPDATE transcript_events SET payload_json = ? WHERE event_id = ?
	`).run(storedPayload({
		text: "updatedxsearchterm",
		clientUserMessageId: "mutable-user",
		source: "submit",
	}), "mutable");
	assert.equal(repository.searchMessages("insertxsearchterm").length, 0);
	assert.equal(repository.searchMessages("updatedxsearchterm").length, 1);

	database.prepare("DELETE FROM transcript_events WHERE event_id = ?").run("mutable");
	assert.equal(repository.searchMessages("updatedxsearchterm").length, 0);
});

function seedLegacySearchDatabase(dbPath: string): SQLiteSessionStore {
	new SQLiteSessionStore({ dbPath }).close();
	const database = new Database(dbPath);
	seedSession(database, "session-a", WORKSPACE, NOW);
	seedSession(database, "session-b", OTHER_WORKSPACE, "2026-08-13T00:00:00.000Z");
	const insert = database.prepare(`
		INSERT INTO conversation_messages (session_id, message_index, payload_json)
		VALUES (?, ?, ?)
	`);
	const longPrefix = "prefix ".repeat(40);
	insert.run("session-a", 0, JSON.stringify({
		role: "user",
		content: `${longPrefix}Alpha.beta repository marker ${"suffix ".repeat(40)}`,
	}));
	insert.run("session-a", 1, JSON.stringify({
		role: "assistant",
		content: "Assistant saw Alpha.beta repository marker.",
	}));
	insert.run("session-b", 0, JSON.stringify({
		role: "user",
		content: "Alpha.beta repository marker in another workspace",
	}));
	database.close();
	return new SQLiteSessionStore({ dbPath });
}

function seedEventSessions(dbPath: string): void {
	const database = new Database(dbPath);
	seedSession(database, "session-a", WORKSPACE, NOW);
	seedSession(database, "session-b", OTHER_WORKSPACE, "2026-08-13T00:00:00.000Z");
	database.close();
}

function seedSession(
	database: Database.Database,
	sessionId: string,
	workspaceRoot: string,
	lastActiveAt: string,
): void {
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at,
			updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, 'active')
	`).run(sessionId, workspaceRoot, `thread-${sessionId}`, NOW, NOW, lastActiveAt);
}

function append(
	repository: SQLiteTranscriptEventRepository,
	sessionId: string,
	eventId: string,
	eventType: "user_input" | "assistant_output",
	payload: Readonly<Record<string, unknown>>,
): void {
	repository.appendEvent(parseTranscriptEventAppendInput({
		schemaVersion: TRANSCRIPT_EVENT_SCHEMA_VERSION,
		sessionId,
		eventId,
		turnId: `turn-${eventId}`,
		eventType,
		modelVisible: true,
		createdAt: NOW,
		payload,
	}));
}

function comparable(results: readonly SessionSearchResult[]): readonly unknown[] {
	return results.map((result) => ({
		messageIndex: result.messageIndex,
		role: result.role,
		snippet: result.snippet,
	})).sort((left, right) => left.messageIndex - right.messageIndex);
}

function storedPayload(payload: Readonly<Record<string, unknown>>): string {
	return JSON.stringify({ schemaVersion: TRANSCRIPT_EVENT_SCHEMA_VERSION, payload });
}

async function databaseFixture(t: test.TestContext): Promise<{
	readonly v9Path: string;
	readonly v10Path: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-event-search-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return {
		v9Path: join(root, "v9.db"),
		v10Path: join(root, "v10.db"),
	};
}
