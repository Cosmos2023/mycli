import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeTurnRecord } from "@mycli/contracts";
import type { CanonicalMessage, ProviderUsage, RuntimeErrorCode } from "@mycli/core";
import * as storage from "../src/index.ts";

interface ReserveTurnInput {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly turnId: string;
	readonly requestFingerprint: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly userText: string;
	readonly startedAt: string;
}

interface CompleteStoredTurnInput {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly assistantText: string;
	readonly usage: ProviderUsage;
	readonly responseId?: string;
	readonly completedAt: string;
}

interface FailStoredTurnInput {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly code: RuntimeErrorCode;
	readonly message: string;
	readonly completedAt: string;
}

interface Store {
	reserveTurn(input: ReserveTurnInput): {
		readonly kind: "reserved" | "existing";
		readonly turn: RuntimeTurnRecord;
	};
	loadTurn(sessionId: string, clientTurnId: string): RuntimeTurnRecord | undefined;
	loadConversation(sessionId: string): readonly CanonicalMessage[];
	completeTurn(input: CompleteStoredTurnInput): RuntimeTurnRecord;
	failTurn(input: FailStoredTurnInput): RuntimeTurnRecord;
	close(): void;
}

type StoreConstructor = new (options: {
	readonly dbPath: string;
	readonly clock?: () => string;
	readonly busyTimeoutMs?: number;
}) => Store;

test("initializes the complete schema-v2 shape plus runtime turn reservations", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	store.close();
	const database = await openDatabase(fixture.dbPath);
	t.after(() => database.close());

	const tables = database.prepare(
		"SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
	).all().map((row) => String((row as { name: unknown }).name));
	const triggers = database.prepare(
		"SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
	).all().map((row) => String((row as { name: unknown }).name));

	for (const table of [
		"schema_version",
		"sessions",
		"conversation_messages",
		"conversation_messages_fts",
		"conversation_trees",
		"history_items",
		"history_items_fts",
		"turn_rollouts",
		"session_state",
		"session_summaries",
		"runtime_turns",
	]) {
		assert.ok(tables.includes(table), `missing table ${table}`);
	}
	assert.deepEqual(triggers, [
		"conversation_messages_fts_delete",
		"conversation_messages_fts_insert",
		"conversation_messages_fts_update",
		"history_items_fts_delete",
		"history_items_fts_insert",
		"history_items_fts_update",
	]);
	assert.equal((database.prepare("SELECT version FROM schema_version").get() as { version: number }).version, 2);
});

test("opens an existing schema-v2 database additively without changing existing messages", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock }).close();
	const database = await openDatabase(fixture.dbPath);
	database.exec("DROP TABLE runtime_turns");
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at, updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run("legacy", fixture.root, "legacy", NOW, NOW, NOW, "active");
	database.prepare(`
		INSERT INTO conversation_messages (session_id, message_index, payload_json)
		VALUES (?, ?, ?)
	`).run("legacy", 0, JSON.stringify({ role: "user", content: "legacy message" }));
	database.close();

	const reopened = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => reopened.close());

	assert.deepEqual(reopened.loadConversation("legacy"), [
		{ role: "user", content: "legacy message" },
	]);
});

test("reserves a turn atomically and deduplicates the same fingerprint", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => store.close());
	const input = submission(fixture.root);

	const first = store.reserveTurn(input);
	const duplicate = store.reserveTurn(input);

	assert.equal(first.kind, "reserved");
	assert.equal(duplicate.kind, "existing");
	assert.equal(first.turn.status, "in_progress");
	assert.equal(duplicate.turn.turn_id, first.turn.turn_id);
	assert.deepEqual(store.loadConversation("session-1"), [
		{ role: "user", content: "inspect the repository" },
	]);
	assert.throws(
		() => store.reserveTurn({ ...input, requestFingerprint: `sha256:${"b".repeat(64)}` }),
		/message_id_conflict: client_turn_id already has a different payload/,
	);

	const database = await openDatabase(fixture.dbPath);
	t.after(() => database.close());
	assert.equal(count(database, "conversation_messages"), 1);
	assert.equal(count(database, "history_items"), 1);
	assert.equal(count(database, "runtime_turns"), 1);
});

test("completes a turn with one assistant message, history item, and rollout", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => store.close());
	store.reserveTurn({ ...submission(fixture.root), threadId: "thread-1" });

	const completed = store.completeTurn({
		sessionId: "session-1",
		clientTurnId: "client-1",
		assistantText: "Repository inspected.",
		usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
		responseId: "resp-1",
		completedAt: LATER,
	});

	assert.equal(completed.status, "completed");
	assert.deepEqual(completed.result, {
		assistant_text: "Repository inspected.",
		response_id: "resp-1",
		usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
	});
	assert.deepEqual(store.loadConversation("session-1"), [
		{ role: "user", content: "inspect the repository" },
		{ role: "assistant", content: "Repository inspected." },
	]);

	const database = await openDatabase(fixture.dbPath);
	t.after(() => database.close());
	assert.equal(count(database, "conversation_messages"), 2);
	assert.equal(count(database, "history_items"), 2);
	assert.equal(count(database, "turn_rollouts"), 1);
	const rollout = JSON.parse(String((database.prepare(
		"SELECT payload_json FROM turn_rollouts WHERE session_id = ?",
	).get("session-1") as { payload_json: unknown }).payload_json)) as Record<string, unknown>;
	const assistantHistory = JSON.parse(String((database.prepare(`
		SELECT payload_json
		FROM history_items
		WHERE session_id = ?
		ORDER BY sequence_no DESC
		LIMIT 1
	`).get("session-1") as { payload_json: unknown }).payload_json)) as Record<string, unknown>;
	assert.equal(rollout.status, "completed");
	assert.equal(rollout.stop_reason, "assistant_completed");
	assert.equal(rollout.thread_id, "thread-1");
	assert.equal(assistantHistory.thread_id, "thread-1");
});

test("persists a failed turn without adding partial assistant content", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => store.close());
	store.reserveTurn(submission(fixture.root));

	const failed = store.failTurn({
		sessionId: "session-1",
		clientTurnId: "client-1",
		code: "provider_error",
		message: "provider request failed",
		completedAt: LATER,
	});

	assert.equal(failed.status, "failed");
	assert.equal(failed.error_code, "provider_error");
	assert.deepEqual(store.loadConversation("session-1"), [
		{ role: "user", content: "inspect the repository" },
	]);
});

test("rejects malformed canonical message JSON with a sanitized persistence error", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	store.reserveTurn(submission(fixture.root));
	store.close();
	const database = await openDatabase(fixture.dbPath);
	database.prepare(
		"UPDATE conversation_messages SET payload_json = ? WHERE session_id = ?",
	).run("{private-invalid-json", "session-1");
	database.close();
	const reopened = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => reopened.close());

	assert.throws(
		() => reopened.loadConversation("session-1"),
		(error: unknown) => error instanceof Error
			&& error.message === "persistence_error: invalid JSON in conversation_messages",
	);
});

test("reports a bounded persistence error when another writer holds the database", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({
		dbPath: fixture.dbPath,
		clock: fixedClock,
		busyTimeoutMs: 5,
	});
	t.after(() => store.close());
	const blocker = await openDatabase(fixture.dbPath);
	blocker.pragma("journal_mode = WAL");
	blocker.exec("BEGIN IMMEDIATE");

	try {
		assert.throws(
			() => store.reserveTurn(submission(fixture.root)),
			(error: unknown) => error instanceof Error
				&& error.message === "persistence_error: database is busy"
				&& "diagnostics" in error
				&& JSON.stringify(error.diagnostics) === "{\"sqlite_code\":\"SQLITE_BUSY\"}",
		);
	} finally {
		blocker.exec("ROLLBACK");
		blocker.close();
	}

	assert.equal(store.loadTurn("session-1", "client-1"), undefined);
});

const NOW = "2026-08-03T00:00:00+00:00";
const LATER = "2026-08-03T00:00:01+00:00";

function fixedClock(): string {
	return NOW;
}

function constructor(): StoreConstructor {
	const value = Reflect.get(storage, "SQLiteSessionStore") as StoreConstructor | undefined;
	assert.equal(typeof value, "function");
	return value!;
}

function submission(workspaceRoot: string): ReserveTurnInput {
	return {
		sessionId: "session-1",
		clientTurnId: "client-1",
		turnId: "turn-1",
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot,
		threadId: "session-1",
		userText: "inspect the repository",
		startedAt: NOW,
	};
}

async function databaseFixture(t: test.TestContext): Promise<{ root: string; dbPath: string }> {
	const root = await mkdtemp(join(tmpdir(), "mycli-node-storage-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return { root, dbPath: join(root, ".mycli", "sessions.db") };
}

async function openDatabase(path: string) {
	const module = await import("better-sqlite3");
	return new module.default(path);
}

function count(database: Awaited<ReturnType<typeof openDatabase>>, table: string): number {
	const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
	return row.count;
}
