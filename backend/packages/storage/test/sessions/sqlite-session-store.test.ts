import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	TURN_INTERRUPTED_NOTICE,
	turnFailedNoticeId,
	turnFailureNotice,
	turnInterruptedNoticeId,
	type RuntimeTurnRecord,
} from "@mycli/contracts";
import type {
	CanonicalConversationItem,
	CanonicalContextMetadata,
	CanonicalImage,
	CanonicalMessage,
	CanonicalToolCall,
	CanonicalToolResult,
	ProviderReplayState,
	ProviderUsage,
	RuntimeErrorCode,
} from "@mycli/core";
import { parseProviderRouteId } from "@mycli/core";
import * as storage from "../../src/index.ts";
import type {
	AgentEffectLedgerStore,
	ReserveAgentEffectAttemptInput,
} from "../../src/index.ts";
import { restoreLegacySearchProjection } from "../support/v9-normalization-fixtures.ts";

interface ReserveTurnInput {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly clientUserMessageId: string;
	readonly turnId: string;
	readonly requestFingerprint: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly userText: string;
	readonly queueId?: string;
	readonly inputSource?: "submit" | "steer" | "queued";
	readonly imagePaths?: readonly string[];
	readonly images?: readonly CanonicalImage[];
	readonly startedAt: string;
}

interface CompleteStoredTurnInput {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly assistantText: string;
	readonly usage: ProviderUsage;
	readonly lastTokenUsage?: ProviderUsage;
	readonly responseId?: string;
	readonly providerState?: ProviderReplayState;
	readonly completedAt: string;
}

interface FailStoredTurnInput {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly code: RuntimeErrorCode;
	readonly message: string;
	readonly additionalDetails?: string;
	readonly diagnostics?: Readonly<Record<string, string | number | boolean | null>>;
	readonly completedAt: string;
}

interface Store {
	readonly agentEffectLedger: AgentEffectLedgerStore;
	reserveTurn(input: ReserveTurnInput): {
		readonly kind: "reserved" | "existing";
		readonly turn: RuntimeTurnRecord;
	};
	loadTurn(sessionId: string, clientTurnId: string): RuntimeTurnRecord | undefined;
	loadConversation(sessionId: string): readonly CanonicalMessage[];
	loadConversationItems(sessionId: string): readonly CanonicalConversationItem[];
	loadHistoryItems(sessionId: string): readonly Readonly<Record<string, unknown>>[];
	loadCommittedQueueIds(sessionId: string): ReadonlySet<string>;
	loadRecentHistoryItems(
		sessionId: string,
		limit: number,
	): readonly Readonly<Record<string, unknown>>[];
	loadRecentTurnRollouts(
		sessionId: string,
		limit: number,
	): readonly Readonly<Record<string, unknown>>[];
	loadHistoryItemWindow(
		sessionId: string,
		beforeSequence: number | undefined,
		limit: number,
	): storage.HistoryItemWindow;
	loadTurnRolloutsForTurns(
		sessionId: string,
		turnIds: readonly string[],
	): readonly Readonly<Record<string, unknown>>[];
	searchMessages(
		query: string,
		options?: storage.SessionSearchQuery,
	): readonly storage.SessionSearchResult[];
	appendAssistantToolCalls(input: {
		readonly sessionId: string;
		readonly clientTurnId: string;
		readonly assistantText: string;
		readonly calls: readonly CanonicalToolCall[];
		readonly responseId?: string;
		readonly providerState?: ProviderReplayState;
	}): void;
	appendContextItem(input: {
		readonly sessionId: string;
		readonly itemId: string;
		readonly text: string;
		readonly metadata: CanonicalContextMetadata;
	}): void;
	appendToolResult(input: {
		readonly sessionId: string;
		readonly clientTurnId: string;
		readonly result: CanonicalToolResult;
		readonly summary: string;
		readonly metadata?: Readonly<Record<string, unknown>>;
		readonly errorKind?: string;
		readonly contextItem?: {
			readonly itemId: string;
			readonly text: string;
			readonly metadata: CanonicalContextMetadata;
		};
		readonly planUpdate?: {
			readonly explanation?: string;
			readonly items: readonly {
				readonly id: string;
				readonly text: string;
				readonly status: "pending" | "in_progress" | "completed";
			}[];
		};
		readonly toolActivation?: { readonly names: readonly string[] };
	}): void;
	loadToolActivations(sessionId: string, turnId: string): readonly string[];
	completeTurn(input: CompleteStoredTurnInput): RuntimeTurnRecord;
	failTurn(input: FailStoredTurnInput): RuntimeTurnRecord;
	recoverInterruptedTurn(
		sessionId: string,
		turnId: string,
		userInitiated?: boolean,
	): RuntimeTurnRecord | undefined;
	close(): void;
}

type StoreConstructor = new (options: {
	readonly dbPath: string;
	readonly clock?: () => string;
	readonly busyTimeoutMs?: number;
}) => Store;

test("initializes the complete schema-v9 shape plus transcript projection indexes", async (t) => {
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
		"turn_rollouts",
		"session_state",
		"session_summaries",
		"runtime_turns",
		"agent_threads",
		"agent_spawn_edges",
		"agent_runtime_leases",
		"agent_mailbox_items",
		"model_input_blobs",
		"instruction_snapshots",
		"tool_set_snapshots",
		"model_context_events",
		"provider_input_timeline_events",
		"provider_request_manifests",
		"provider_step_events",
		"shell_output_chunks",
		"agent_effect_attempts",
		"agent_effect_attempt_outcomes",
	]) {
		assert.ok(tables.includes(table), `missing table ${table}`);
	}
	for (const trigger of [
		"conversation_messages_fts_delete",
		"conversation_messages_fts_insert",
		"conversation_messages_fts_update",
		"model_input_blobs_no_update",
		"model_input_blobs_no_delete",
		"instruction_snapshots_no_update",
		"instruction_snapshots_no_delete",
		"tool_set_snapshots_no_update",
		"tool_set_snapshots_no_delete",
		"model_context_events_no_update",
		"model_context_events_no_delete",
		"provider_input_timeline_events_no_update",
		"provider_input_timeline_events_no_delete",
		"provider_request_manifests_no_update",
		"provider_request_manifests_no_delete",
		"provider_step_events_no_update",
		"provider_step_events_no_delete",
		"shell_output_chunks_no_update",
		"agent_effect_attempts_no_update",
		"agent_effect_attempts_no_delete",
		"agent_effect_attempt_outcomes_no_update",
		"agent_effect_attempt_outcomes_no_delete",
	]) {
		assert.ok(triggers.includes(trigger), `missing trigger ${trigger}`);
	}
	const indexes = database.prepare(
		"SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
	).all().map((row) => String((row as { name: unknown }).name));
	assert.ok(indexes.includes("idx_history_items_session_sequence"));
	assert.ok(indexes.includes("idx_turn_rollouts_session_sequence"));
	assert.ok(indexes.includes("idx_turn_rollouts_session_turn_sequence"));
	assert.ok(indexes.includes("idx_session_summaries_session_sequence"));
	assert.equal(tables.includes("conversation_messages_fts_content"), false);
	assert.equal(tables.some((table) => table.startsWith("history_items_fts")), false);
	const searchSql = String((database.prepare(`
		SELECT sql FROM sqlite_master
		WHERE type = 'table' AND name = 'conversation_messages_fts'
	`).get() as { sql: unknown }).sql);
	assert.match(searchSql, /content='conversation_messages'/u);
	assert.match(searchSql, /content_rowid='rowid'/u);
	assert.equal((database.prepare("SELECT version FROM schema_version").get() as { version: number }).version, 9);
	const runtimeTurnColumns = database.prepare("PRAGMA table_info(runtime_turns)").all()
		.map((row) => String((row as { name: unknown }).name));
	assert.ok(runtimeTurnColumns.includes("owner_id"));
	assert.ok(runtimeTurnColumns.includes("owner_pid"));
	assert.equal(storage.SCHEMA_VERSION, 9);
});

test("reopens the current schema without rewriting its migration marker", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock }).close();
	const database = await openDatabase(fixture.dbPath);
	database.exec(`
		CREATE TRIGGER reject_schema_version_rewrite
		BEFORE DELETE ON schema_version BEGIN
			SELECT RAISE(ABORT, 'current schema must not be migrated again');
		END;
	`);
	database.close();

	const reopened = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	reopened.close();
});

test("opens an existing schema-v2 database additively without changing existing messages", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock }).close();
	const database = await openDatabase(fixture.dbPath);
	database.exec("DROP TABLE agent_runtime_leases");
	database.exec("DROP TABLE agent_spawn_edges");
	database.exec("DROP TABLE agent_threads");
	database.prepare("UPDATE schema_version SET version = 2").run();
	database.exec("DROP TABLE runtime_turns");
	database.exec(`
		CREATE TABLE runtime_turns (
			session_id TEXT NOT NULL,
			client_turn_id TEXT NOT NULL,
			turn_id TEXT NOT NULL,
			request_fingerprint TEXT NOT NULL,
			status TEXT NOT NULL,
			error_code TEXT,
			result_json TEXT,
			started_at TEXT NOT NULL,
			completed_at TEXT,
			PRIMARY KEY (session_id, client_turn_id),
			FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
		)
	`);
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
	const migrated = await openDatabase(fixture.dbPath);
	t.after(() => migrated.close());
	const runtimeTurnColumns = migrated.prepare("PRAGMA table_info(runtime_turns)").all()
		.map((row) => String((row as { name: unknown }).name));
	assert.ok(runtimeTurnColumns.includes("owner_id"));
	assert.ok(runtimeTurnColumns.includes("owner_pid"));
	assert.equal(count(migrated, "agent_threads"), 0);
	assert.equal(
		(migrated.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
			9,
	);
});

test("opens an existing schema-v3 database and adds the mailbox table", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock }).close();
	const database = await openDatabase(fixture.dbPath);
	database.exec("DROP TABLE agent_mailbox_items");
	database.prepare("UPDATE schema_version SET version = 3").run();
	database.close();

	const reopened = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => reopened.close());
	const migrated = await openDatabase(fixture.dbPath);
	t.after(() => migrated.close());
	assert.equal(
		(migrated.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
			9,
	);
	assert.equal(
		Number((migrated.prepare(`
			SELECT COUNT(*) AS count
			FROM sqlite_master
			WHERE type = 'table' AND name = 'agent_mailbox_items'
		`).get() as { count: unknown }).count),
		1,
	);
});

test("opens an existing schema-v4 database and adds model-input ledger tables", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock }).close();
	const database = await openDatabase(fixture.dbPath);
	for (const trigger of database.prepare(`
		SELECT name FROM sqlite_master
		WHERE type = 'trigger' AND (
			name LIKE 'provider_input_timeline_events_%'
			OR
			name LIKE 'model_input_blobs_%'
			OR name LIKE 'instruction_snapshots_%'
			OR name LIKE 'tool_set_snapshots_%'
			OR name LIKE 'model_context_events_%'
			OR name LIKE 'provider_request_manifests_%'
			OR name LIKE 'provider_step_events_%'
		)
	`).all() as readonly { name: string }[]) {
		database.exec(`DROP TRIGGER ${trigger.name}`);
	}
	for (const table of [
		"provider_input_timeline_events",
		"provider_step_events",
		"provider_request_manifests",
		"model_context_events",
		"tool_set_snapshots",
		"instruction_snapshots",
		"model_input_blobs",
	]) {
		database.exec(`DROP TABLE ${table}`);
	}
	database.prepare("UPDATE schema_version SET version = 4").run();
	database.close();

	const reopened = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => reopened.close());
	const migrated = await openDatabase(fixture.dbPath);
	t.after(() => migrated.close());
	assert.equal(
		(migrated.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
		9,
	);
	for (const table of [
		"model_input_blobs",
		"instruction_snapshots",
		"tool_set_snapshots",
		"model_context_events",
		"provider_request_manifests",
		"provider_step_events",
		"provider_input_timeline_events",
	]) {
		assert.equal(count(migrated, table), 0);
	}
});

test("opens an existing schema-v5 database and adds provider timeline storage", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock }).close();
	const database = await openDatabase(fixture.dbPath);
	database.exec("DROP TRIGGER provider_input_timeline_events_no_update");
	database.exec("DROP TRIGGER provider_input_timeline_events_no_delete");
	database.exec("DROP TABLE provider_input_timeline_events");
	database.prepare("UPDATE schema_version SET version = 5").run();
	database.close();

	const reopened = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => reopened.close());
	const migrated = await openDatabase(fixture.dbPath);
	t.after(() => migrated.close());
	assert.equal(
		(migrated.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
			9,
	);
	assert.equal(count(migrated, "provider_input_timeline_events"), 0);
	const triggers = migrated.prepare(`
		SELECT name FROM sqlite_master
		WHERE type = 'trigger' AND name LIKE 'provider_input_timeline_events_%'
	`).all() as readonly { name: string }[];
	assert.deepEqual(triggers.map((row) => row.name).sort(), [
		"provider_input_timeline_events_no_delete",
		"provider_input_timeline_events_no_update",
	]);
});

test("opens an existing schema-v6 database and adds append-only shell output storage", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock }).close();
	const database = await openDatabase(fixture.dbPath);
	database.exec("DROP TRIGGER shell_output_chunks_no_update");
	database.exec("DROP TABLE shell_output_chunks");
	database.prepare("UPDATE schema_version SET version = 6").run();
	database.close();

	const reopened = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => reopened.close());
	const migrated = await openDatabase(fixture.dbPath);
	t.after(() => migrated.close());
	assert.equal(
		(migrated.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
		9,
	);
	assert.equal(count(migrated, "shell_output_chunks"), 0);
	const triggers = migrated.prepare(`
		SELECT name FROM sqlite_master
		WHERE type = 'trigger' AND name = 'shell_output_chunks_no_update'
	`).all() as readonly { name: string }[];
	assert.deepEqual(triggers.map((row) => row.name), ["shell_output_chunks_no_update"]);
});

test("opens an existing schema-v7 database and adds durable agent effect attempts", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock }).close();
	const database = await openDatabase(fixture.dbPath);
	for (const trigger of database.prepare(`
		SELECT name FROM sqlite_master
		WHERE type = 'trigger' AND name LIKE 'agent_effect_attempt%'
	`).all() as readonly { name: string }[]) {
		database.exec(`DROP TRIGGER ${trigger.name}`);
	}
	database.exec("DROP TABLE agent_effect_attempt_outcomes");
	database.exec("DROP TABLE agent_effect_attempts");
	database.prepare("UPDATE schema_version SET version = 7").run();
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at, updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run("legacy-v7", fixture.root, "legacy-v7", NOW, NOW, NOW, "active");
	database.prepare(`
		INSERT INTO conversation_messages (session_id, message_index, payload_json)
		VALUES (?, ?, ?)
	`).run("legacy-v7", 0, JSON.stringify({ role: "user", content: "preserved" }));
	database.close();

	const reopened = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => reopened.close());
	assert.deepEqual(reopened.loadConversation("legacy-v7"), [
		{ role: "user", content: "preserved" },
	]);
	const migrated = await openDatabase(fixture.dbPath);
	t.after(() => migrated.close());
	assert.equal(
		(migrated.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
		9,
	);
	assert.equal(count(migrated, "agent_effect_attempts"), 0);
	assert.equal(count(migrated, "agent_effect_attempt_outcomes"), 0);
});

test("migrates schema v8 search to external content and keeps trigger synchronization", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock }).close();
	const database = await openDatabase(fixture.dbPath);
	restoreLegacySearchProjection(database);
	database.prepare("UPDATE schema_version SET version = 8").run();
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at, updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run("legacy-search", fixture.root, "legacy-search", NOW, NOW, NOW, "active");
	database.prepare(`
		INSERT INTO conversation_messages (session_id, message_index, payload_json)
		VALUES (?, ?, ?)
	`).run("legacy-search", 0, JSON.stringify({ role: "user", content: "migration marker" }));
	database.prepare(`
		INSERT INTO history_items (session_id, item_id, payload_json)
		VALUES (?, ?, ?)
	`).run("legacy-search", "history-1", JSON.stringify({
		id: "history-1",
		turn_id: "turn-1",
		type: "user_message",
		text: "history marker",
	}));
	database.close();

	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => store.close());
	assert.deepEqual(store.searchMessages("migration").map((result) => result.messageIndex), [0]);

	const migrated = await openDatabase(fixture.dbPath);
	const tables = migrated.prepare(
		"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
	).all().map((row) => String((row as { name: unknown }).name));
	assert.equal(tables.includes("conversation_messages_fts_content"), false);
	assert.equal(tables.some((table) => table.startsWith("history_items_fts")), false);
	assert.equal(
		(migrated.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
		9,
	);

	migrated.prepare(`
		INSERT INTO conversation_messages (session_id, message_index, payload_json)
		VALUES (?, ?, ?)
	`).run("legacy-search", 1, JSON.stringify({ role: "assistant", content: "insert marker" }));
	assert.equal(store.searchMessages("insert").length, 1);
	migrated.prepare(`
		UPDATE conversation_messages SET payload_json = ?
		WHERE session_id = ? AND message_index = ?
	`).run(JSON.stringify({ role: "assistant", content: "updated marker" }), "legacy-search", 1);
	assert.equal(store.searchMessages("insert").length, 0);
	assert.equal(store.searchMessages("updated").length, 1);
	migrated.prepare(`
		DELETE FROM conversation_messages WHERE session_id = ? AND message_index = ?
	`).run("legacy-search", 1);
	assert.equal(store.searchMessages("updated").length, 0);
	migrated.close();
});

test("rolls back a failed schema-v9 search migration and retries cleanly", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock }).close();
	let database = await openDatabase(fixture.dbPath);
	restoreLegacySearchProjection(database);
	database.prepare("UPDATE schema_version SET version = 8").run();
	database.exec(`
		CREATE TRIGGER reject_schema_v9_commit
		BEFORE DELETE ON schema_version BEGIN
			SELECT RAISE(ABORT, 'reject schema v9 commit');
		END;
	`);
	database.close();

	assert.throws(
		() => new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock }),
		(error: unknown) => error instanceof storage.StorageFailure
			&& error.message === "persistence_error: storage operation failed",
	);
	database = await openDatabase(fixture.dbPath);
	assert.equal(
		(database.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
		8,
	);
	const legacyColumns = database.prepare("PRAGMA table_info(conversation_messages_fts)").all()
		.map((row) => String((row as { name: unknown }).name));
	assert.deepEqual(legacyColumns, ["session_id", "message_index", "content"]);
	database.exec("DROP TRIGGER reject_schema_v9_commit");
	database.close();

	const retried = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	retried.close();
	database = await openDatabase(fixture.dbPath);
	t.after(() => database.close());
	assert.equal(
		(database.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
		9,
	);
});

test("opens the current schema and adds compatibility transcript indexes", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock }).close();
	const database = await openDatabase(fixture.dbPath);
	database.exec("DROP INDEX idx_history_items_session_sequence");
	database.exec("DROP INDEX idx_turn_rollouts_session_sequence");
	database.exec("DROP INDEX idx_turn_rollouts_session_turn_sequence");
	database.exec("DROP INDEX idx_session_summaries_session_sequence");
	database.exec(`
		CREATE TRIGGER reject_compatibility_index_version_rewrite
		BEFORE DELETE ON schema_version BEGIN
			SELECT RAISE(ABORT, 'compatibility indexes must not rewrite schema version');
		END;
	`);
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at, updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run("legacy-v8", fixture.root, "legacy-v8", NOW, NOW, NOW, "active");
	for (let index = 1; index <= 4; index += 1) {
		database.prepare(`
			INSERT INTO history_items (session_id, item_id, payload_json)
			VALUES (?, ?, ?)
		`).run("legacy-v8", `item-${index}`, JSON.stringify({
			id: `item-${index}`,
			turn_id: `turn-${index}`,
			type: "assistant_message",
			text: `message-${index}`,
		}));
		database.prepare(`
			INSERT INTO turn_rollouts (session_id, turn_id, payload_json)
			VALUES (?, ?, ?)
		`).run("legacy-v8", `turn-${index}`, JSON.stringify({
			turn_id: `turn-${index}`,
			events: [],
		}));
	}
	database.close();

	const reopened = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => reopened.close());
	assert.deepEqual(
		reopened.loadRecentHistoryItems("legacy-v8", 2).map((item) => item.id),
		["item-3", "item-4"],
	);
	assert.deepEqual(
		reopened.loadRecentTurnRollouts("legacy-v8", 2).map((item) => item.turn_id),
		["turn-3", "turn-4"],
	);
	const latestWindow = reopened.loadHistoryItemWindow("legacy-v8", undefined, 2);
	assert.deepEqual(latestWindow.items.map((item) => item.payload.id), ["item-4", "item-3"]);
	assert.equal(latestWindow.hasMore, true);
	const earlierWindow = reopened.loadHistoryItemWindow(
		"legacy-v8",
		latestWindow.items.at(-1)?.sequenceNo,
		2,
	);
	assert.deepEqual(earlierWindow.items.map((item) => item.payload.id), ["item-2", "item-1"]);
	assert.equal(earlierWindow.hasMore, false);
	assert.deepEqual(
		reopened.loadTurnRolloutsForTurns("legacy-v8", ["turn-4", "turn-2"])
			.map((item) => item.turn_id),
		["turn-2", "turn-4"],
	);
	assert.equal(reopened.loadHistoryItems("legacy-v8").length, 4);
	assert.throws(() => reopened.loadRecentHistoryItems("legacy-v8", 0), /between 1 and 10000/u);
	assert.throws(() => reopened.loadRecentTurnRollouts("legacy-v8", 10_001), /between 1 and 10000/u);

	const migrated = await openDatabase(fixture.dbPath);
	t.after(() => migrated.close());
	const indexes = migrated.prepare(`
		SELECT name FROM sqlite_master
		WHERE type = 'index' AND name IN (
			'idx_history_items_session_sequence',
			'idx_turn_rollouts_session_sequence',
			'idx_turn_rollouts_session_turn_sequence',
			'idx_session_summaries_session_sequence'
		)
		ORDER BY name
	`).all() as readonly { name: string }[];
	assert.deepEqual(indexes.map((row) => row.name), [
		"idx_history_items_session_sequence",
		"idx_session_summaries_session_sequence",
		"idx_turn_rollouts_session_sequence",
		"idx_turn_rollouts_session_turn_sequence",
	]);
	const historyQueryPlan = migrated.prepare(`
		EXPLAIN QUERY PLAN
		SELECT payload_json FROM history_items
		WHERE session_id = ? ORDER BY sequence_no DESC LIMIT ?
	`).all("legacy-v8", 2) as readonly { detail: unknown }[];
	assert.equal(
		historyQueryPlan.some((row) => String(row.detail).includes(
			"idx_history_items_session_sequence",
		)),
		true,
	);
	assert.equal(
		(migrated.prepare("SELECT version FROM schema_version").get() as { version: number }).version,
		9,
	);
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
	const userHistory = store.loadHistoryItems("session-1")[0];
	assert.equal(userHistory?.id, "turn-1:user:user-message-1");
	assert.equal(
		(userHistory?.metadata as Readonly<Record<string, unknown>> | undefined)
			?.client_user_message_id,
		"user-message-1",
	);
	assert.equal(
		(userHistory?.metadata as Readonly<Record<string, unknown>> | undefined)?.source,
		"submit",
	);
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

test("queued turn reservation commits queue identity and source with the user input", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => store.close());
	const input = {
		...submission(fixture.root),
		clientTurnId: "queued-client",
		clientUserMessageId: "queued-client",
		turnId: "queued-turn",
		queueId: "queue-next",
		inputSource: "steer" as const,
		userText: "continue from the queue",
	};

	const reservation = store.reserveTurn(input);

	assert.equal(reservation.kind, "reserved");
	assert.deepEqual([...store.loadCommittedQueueIds("session-1")], ["queue-next"]);
	assert.deepEqual(store.loadConversation("session-1"), [
		{ role: "user", content: "continue from the queue" },
	]);
	const userHistory = store.loadHistoryItems("session-1")[0];
	assert.equal(userHistory?.id, "queued-turn:queue:queue-next");
	assert.deepEqual(userHistory?.metadata, {
		client_turn_id: "queued-client",
		client_user_message_id: "queued-client",
		queue_id: "queue-next",
		source: "steer",
		image_paths: [],
	});

	const database = await openDatabase(fixture.dbPath);
	t.after(() => database.close());
	const message = JSON.parse(String((database.prepare(`
		SELECT payload_json FROM conversation_messages
		WHERE session_id = ? ORDER BY message_index LIMIT 1
	`).get("session-1") as { payload_json: unknown }).payload_json)) as Record<string, unknown>;
	const metadata = message.metadata as Record<string, unknown>;
	assert.equal(metadata.queue_id, "queue-next");
	assert.equal(metadata.source, "steer");
	assert.equal(count(database, "runtime_turns"), 1);
	assert.equal(count(database, "conversation_messages"), 1);
	assert.equal(count(database, "history_items"), 1);
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
		lastTokenUsage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
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
	assert.deepEqual(
		(rollout.continuation_state as Readonly<Record<string, unknown>>).last_token_usage,
		{ input_tokens: 7, output_tokens: 3, total_tokens: 10 },
	);
	assert.equal(assistantHistory.thread_id, "thread-1");
});

test("persists ordered Python-compatible tool calls and results", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => store.close());
	store.reserveTurn({ ...submission(fixture.root), threadId: "thread-1" });
	const calls: readonly CanonicalToolCall[] = [
		{
			callId: "call-1",
			name: "Read",
			argumentsJson: "{\"file_path\":\"README.md\",\"offset\":1,\"limit\":20}",
		},
		{
			callId: "call-2",
			name: "Read",
			argumentsJson: "{\"file_path\":\"package.json\",\"offset\":1,\"limit\":20}",
		},
	];
	store.appendAssistantToolCalls({
		sessionId: "session-1",
		clientTurnId: "client-1",
		assistantText: "Checking both files.",
		calls,
		responseId: "resp-tools-1",
	});

	assert.throws(() => store.appendToolResult({
		sessionId: "session-1",
		clientTurnId: "client-1",
		result: {
			callId: "call-2",
			toolName: "Read",
			output: "package",
			success: true,
		},
		summary: "Read package.json",
	}), /persistence_error: tool results must preserve call order/);

	for (const [index, call] of calls.entries()) {
		store.appendToolResult({
			sessionId: "session-1",
			clientTurnId: "client-1",
			result: {
				callId: call.callId,
				toolName: call.name,
				output: index === 0 ? "readme" : "package",
				success: true,
			},
			summary: index === 0 ? "Read README.md" : "Read package.json",
		});
	}

	assert.deepEqual(store.loadConversationItems("session-1"), [
		{ type: "user", text: "inspect the repository" },
		{
			type: "assistant_tool_calls",
			text: "Checking both files.",
			calls: [
				{ ...calls[0]!, argumentsJson: "{\"file_path\":\"README.md\",\"limit\":20,\"offset\":1}" },
				{ ...calls[1]!, argumentsJson: "{\"file_path\":\"package.json\",\"limit\":20,\"offset\":1}" },
			],
			responseId: "resp-tools-1",
		},
		{ type: "tool_result", callId: "call-1", toolName: "Read", output: "readme", success: true },
		{ type: "tool_result", callId: "call-2", toolName: "Read", output: "package", success: true },
	]);

	const database = await openDatabase(fixture.dbPath);
	t.after(() => database.close());
	const rawMessages = database.prepare(`
		SELECT payload_json FROM conversation_messages
		WHERE session_id = ? ORDER BY message_index
	`).all("session-1").map((row) => JSON.parse(String(
		(row as { payload_json: unknown }).payload_json,
	)) as Record<string, unknown>);
	const assistant = rawMessages[1] as Record<string, unknown>;
	const firstResult = rawMessages[2] as Record<string, unknown>;
	assert.equal(assistant.role, "assistant");
	assert.deepEqual(assistant.tool_calls, [
		{
			name: "Read",
			arguments: { file_path: "README.md", offset: 1, limit: 20 },
			reason: "model requested tool",
			call_id: "call-1",
		},
		{
			name: "Read",
			arguments: { file_path: "package.json", offset: 1, limit: 20 },
			reason: "model requested tool",
			call_id: "call-2",
		},
	]);
	assert.equal(firstResult.role, "tool");
	assert.equal(firstResult.tool_call_id, "call-1");
	assert.equal(firstResult.content, "readme");
	assert.equal(JSON.stringify(rawMessages).includes("argumentsJson"), false);

	const historyTypes = database.prepare(`
		SELECT json_extract(payload_json, '$.type') AS type
		FROM history_items WHERE session_id = ? ORDER BY sequence_no
	`).all("session-1").map((row) => (row as { type: unknown }).type);
	assert.deepEqual(historyTypes, [
		"user_message",
		"assistant_message",
		"tool_call",
		"tool_call",
		"tool_result",
		"tool_result",
	]);
	const history = store.loadHistoryItems("session-1");
	assert.equal(history[1]?.text, "Checking both files.");
	assert.deepEqual(
		history.filter((item) => item.type === "tool_call").map((item) => item.text),
		["", ""],
	);
});

test("persists provider replay state and context with its tool result", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => store.close());
	store.reserveTurn({ ...submission(fixture.root), threadId: "thread-1" });
	const providerState: ProviderReplayState = {
		provider: parseProviderRouteId("cloudflare-ai-gateway"),
		value: { thinking: "checked", signature: "sig-test" },
		tokenEstimate: 73,
	};
	const metadata: CanonicalContextMetadata = {
		kind: "skill_instructions",
		cacheClass: "dynamic",
		durability: "persistent",
		scope: "transcript",
		sourceId: "review",
		contentSha256: "a".repeat(64),
		contentLength: 12,
	};
	store.appendAssistantToolCalls({
		sessionId: "session-1",
		clientTurnId: "client-1",
		assistantText: "",
		calls: [{ callId: "call-1", name: "Read", argumentsJson: "{}" }],
		providerState,
	});
	store.appendToolResult({
		sessionId: "session-1",
		clientTurnId: "client-1",
		result: {
			callId: "call-1",
			toolName: "Read",
			output: "contents",
			success: true,
		},
		summary: "Read file",
		contextItem: {
			itemId: "turn-1:skill:review",
			text: "instructions",
			metadata,
		},
	});

	assert.deepEqual(store.loadConversationItems("session-1").slice(-3), [
		{
			type: "assistant_tool_calls",
			text: "",
			calls: [{ callId: "call-1", name: "Read", argumentsJson: "{}" }],
			providerState,
		},
		{ type: "tool_result", callId: "call-1", toolName: "Read", output: "contents", success: true },
		{ type: "context", text: "instructions", metadata },
	]);
	assert.deepEqual(
		store.loadHistoryItems("session-1").map((item) => item.type),
		["user_message", "tool_call", "tool_result", "skill_instructions"],
	);
});

test("persists plan updates after tool results without duplicating model conversation", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => store.close());
	store.reserveTurn({ ...submission(fixture.root), threadId: "thread-1" });
	store.appendAssistantToolCalls({
		sessionId: "session-1",
		clientTurnId: "client-1",
		assistantText: "",
		calls: [{
			callId: "call-plan",
			name: "update_plan",
			argumentsJson: JSON.stringify({
				explanation: "Start implementation",
				plan: [{ step: "Wire runtime", status: "in_progress" }],
			}),
		}],
	});
	assert.throws(() => store.appendToolResult({
		sessionId: "session-1",
		clientTurnId: "client-1",
		result: {
			callId: "call-plan",
			toolName: "update_plan",
			output: "update_plan failed",
			success: false,
		},
		summary: "update_plan failed",
		planUpdate: {
			items: [{ id: "step-1", text: "Must not persist", status: "in_progress" }],
		},
	}), /plan update requires a successful update_plan result/u);
	store.appendToolResult({
		sessionId: "session-1",
		clientTurnId: "client-1",
		result: {
			callId: "call-plan",
			toolName: "update_plan",
			output: "Plan updated.",
			success: true,
		},
		summary: "Updated plan with 1 steps",
		planUpdate: {
			explanation: "Start implementation",
			items: [{ id: "step-1", text: "Wire runtime", status: "in_progress" }],
		},
	});

	assert.deepEqual(
		store.loadConversationItems("session-1").map((item) => item.type),
		["user", "assistant_tool_calls", "tool_result"],
	);
	assert.deepEqual(
		store.loadHistoryItems("session-1").map((item) => item.type),
		["user_message", "tool_call", "tool_result", "plan_update"],
	);
	const update = storage.projectTranscript(store.loadHistoryItems("session-1"), []).at(-1);
	assert.equal(update?.type, "plan_update");
	assert.deepEqual(update?.metadata, {
		source: "update_plan",
		explanation: "Start implementation",
		completed: 0,
		total: 1,
		items: [{ id: "step-1", text: "Wire runtime", status: "in_progress" }],
	});
});

test("persists bounded tool_search activations and restores them after reopen", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	let store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	store.reserveTurn({ ...submission(fixture.root), threadId: "thread-1" });
	store.appendAssistantToolCalls({
		sessionId: "session-1",
		clientTurnId: "client-1",
		assistantText: "",
		calls: [{
			callId: "call-search",
			name: "tool_search",
			argumentsJson: '{"query":"docs"}',
		}],
	});
	store.appendToolResult({
		sessionId: "session-1",
		clientTurnId: "client-1",
		result: {
			callId: "call-search",
			toolName: "tool_search",
			output: '{"tools":[{"name":"docs_search"}]}',
			success: true,
		},
		summary: "Activated 2 deferred tools",
		toolActivation: { names: ["docs_search", "calendar_list"] },
	});
	assert.deepEqual(store.loadToolActivations("session-1", "turn-1"), [
		"docs_search",
		"calendar_list",
	]);
	assert.deepEqual(store.loadToolActivations("session-1", "turn-2"), []);
	store.close();

	store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => store.close());
	assert.deepEqual(store.loadToolActivations("session-1", "turn-1"), [
		"docs_search",
		"calendar_list",
	]);
	assert.deepEqual(store.loadToolActivations("session-1", "turn-2"), []);
});

test("rejects malformed or mismatched tool activation effects", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => store.close());
	store.reserveTurn({ ...submission(fixture.root), threadId: "thread-1" });
	store.appendAssistantToolCalls({
		sessionId: "session-1",
		clientTurnId: "client-1",
		assistantText: "",
		calls: [{ callId: "call-read", name: "Read", argumentsJson: "{}" }],
	});
	assert.throws(() => store.appendToolResult({
		sessionId: "session-1",
		clientTurnId: "client-1",
		result: { callId: "call-read", toolName: "Read", output: "done", success: true },
		summary: "Read",
		toolActivation: { names: ["docs_search"] },
	}), /tool activation requires a successful tool_search result/u);

	const second = await databaseFixture(t);
	const secondStore = new SQLiteSessionStore({ dbPath: second.dbPath, clock: fixedClock });
	t.after(() => secondStore.close());
	secondStore.reserveTurn({ ...submission(second.root), threadId: "thread-1" });
	secondStore.appendAssistantToolCalls({
		sessionId: "session-1",
		clientTurnId: "client-1",
		assistantText: "",
		calls: [{ callId: "call-search", name: "tool_search", argumentsJson: "{}" }],
	});
	for (const names of [["bad-route"], ["duplicate", "duplicate"], Array.from({ length: 17 }, (_, index) => `tool_${index}`)]) {
		assert.throws(() => secondStore.appendToolResult({
			sessionId: "session-1",
			clientTurnId: "client-1",
			result: {
				callId: "call-search",
				toolName: "tool_search",
				output: "search result",
				success: true,
			},
			summary: "Search",
			toolActivation: { names },
		}), /tool activation/u);
	}
});

test("persists only bounded Python-compatible mutation file changes", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => store.close());
	store.reserveTurn({ ...submission(fixture.root), threadId: "thread-1" });
	store.appendAssistantToolCalls({
		sessionId: "session-1",
		clientTurnId: "client-1",
		assistantText: "Updating the file.",
		calls: [{
			callId: "call-write",
			name: "Write",
			argumentsJson: "{\"file_path\":\"src/a.ts\",\"content\":\"submitted secret\"}",
		}],
	});
	store.appendToolResult({
		sessionId: "session-1",
		clientTurnId: "client-1",
		result: {
			callId: "call-write",
			toolName: "Write",
			output: "Success. Updated the following files:\nM src/a.ts",
			success: true,
		},
		summary: "Wrote src/a.ts",
		metadata: {
			path: "src/a.ts",
			status: "overwritten",
			diff: "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n",
			addedLines: 1,
			removedLines: 1,
			diffTruncated: false,
			content: "submitted secret",
			sha256: `sha256:${"f".repeat(64)}`,
			nested: { raw: "submitted secret" },
			file_changes: [{ path: "injected.ts" }, { path: "second.ts" }],
		},
	});

	const database = await openDatabase(fixture.dbPath);
	t.after(() => database.close());
	const conversation = JSON.parse(String((database.prepare(`
		SELECT payload_json FROM conversation_messages
		WHERE session_id = ? AND json_extract(payload_json, '$.role') = 'tool'
	`).get("session-1") as { payload_json: unknown }).payload_json)) as {
		metadata: Record<string, unknown>;
		blocks: Array<{ metadata: Record<string, unknown> }>;
	};
	const history = JSON.parse(String((database.prepare(`
		SELECT payload_json FROM history_items
		WHERE session_id = ? AND json_extract(payload_json, '$.type') = 'tool_result'
	`).get("session-1") as { payload_json: unknown }).payload_json)) as {
		metadata: Record<string, unknown>;
	};
	const expected = [{
		version: 1,
		kind: "update",
		path: "src/a.ts",
		diff: "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n",
		added_lines: 1,
		removed_lines: 1,
	}];
	assert.deepEqual(conversation.metadata.file_changes, expected);
	assert.deepEqual(conversation.blocks[0]?.metadata.file_changes, expected);
	assert.deepEqual(history.metadata.file_changes, expected);
	const serializedMetadata = JSON.stringify({
		conversation: conversation.metadata,
		block: conversation.blocks[0]?.metadata,
		history: history.metadata,
	});
	assert.equal(serializedMetadata.includes("submitted secret"), false);
	assert.equal(serializedMetadata.includes("sha256"), false);
	assert.equal(serializedMetadata.includes("injected.ts"), false);
});

test("excludes malformed or oversized mutation metadata", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => store.close());
	store.reserveTurn(submission(fixture.root));
	const metadataCases: readonly Readonly<Record<string, unknown>>[] = [
		{ path: "a".repeat(241), status: "edited", diff: "-a\n+b\n", addedLines: 1, removedLines: 1 },
		{ path: "src/a.ts", status: "edited", diff: "x".repeat(200_001), addedLines: 1, removedLines: 1 },
		{ path: "../escape.ts", status: "edited", diff: "-a\n+b\n", addedLines: 1, removedLines: 1 },
		{ file_changes: [{ path: "a.ts" }, { path: "b.ts" }], nested: { content: "private" } },
	];
	const calls = metadataCases.map((_, index) => ({
		callId: `call-${index + 1}`,
		name: "Edit",
		argumentsJson: "{\"file_path\":\"src/a.ts\",\"old_string\":\"a\",\"new_string\":\"b\"}",
	}));
	store.appendAssistantToolCalls({
		sessionId: "session-1",
		clientTurnId: "client-1",
		assistantText: "Trying invalid metadata cases.",
		calls,
	});
	for (const [index, metadata] of metadataCases.entries()) {
		store.appendToolResult({
			sessionId: "session-1",
			clientTurnId: "client-1",
			result: {
				callId: calls[index]!.callId,
				toolName: "Edit",
				output: "Edit failed",
				success: false,
			},
			summary: "Edit failed",
			metadata,
			errorKind: "invalid_arguments",
		});
	}

	const database = await openDatabase(fixture.dbPath);
	t.after(() => database.close());
	const payloads = database.prepare(`
		SELECT payload_json FROM conversation_messages
		WHERE session_id = ? AND json_extract(payload_json, '$.role') = 'tool'
		ORDER BY message_index
	`).all("session-1").map((row) => JSON.parse(String(
		(row as { payload_json: unknown }).payload_json,
	)) as { metadata: Record<string, unknown>; blocks: Array<{ metadata: Record<string, unknown> }> });
	for (const payload of payloads) {
		assert.equal("file_changes" in payload.metadata, false);
		assert.equal("file_changes" in payload.blocks[0]!.metadata, false);
	}
	assert.equal(JSON.stringify(payloads).includes("private"), false);
});

test("projects bounded structured Patch changes including move identity", () => {
	const project = Reflect.get(storage, "projectMutationMetadata") as (
		value: Readonly<Record<string, unknown>>,
		success: boolean,
	) => Readonly<Record<string, unknown>>;
	const projected = project({
		path: "src/old.ts",
		status: "patched",
		fileChanges: [
			{
				version: 1,
				kind: "move",
				path: "src/new.ts",
				previousPath: "src/old.ts",
				diff: "",
				addedLines: 0,
				removedLines: 0,
				truncated: false,
				omittedChars: 0,
			},
			{
				version: 1,
				kind: "delete",
				path: "src/unused.ts",
				diff: "-unused\n",
				addedLines: 0,
				removedLines: 1,
				truncated: false,
				omittedChars: 0,
			},
		],
		operations: [{ content: "private" }],
	}, true);

	assert.deepEqual(projected.file_changes, [
		{
			version: 1,
			kind: "move",
			path: "src/new.ts",
			previous_path: "src/old.ts",
			diff: "",
			added_lines: 0,
			removed_lines: 0,
		},
		{
			version: 1,
			kind: "delete",
			path: "src/unused.ts",
			diff: "-unused\n",
			added_lines: 0,
			removed_lines: 1,
		},
	]);
	assert.equal(JSON.stringify(projected).includes("private"), false);
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
		code: "invalid_request",
		message: "provider rejected the request",
		additionalDetails: "Invalid schema api_key=private-value (status 400)\n at request (/Users/private/app.ts:1:2)",
		diagnostics: {
			status: 400,
			provider_error_code: "invalid_function_parameters",
		},
		completedAt: LATER,
	});

	assert.equal(failed.status, "failed");
	assert.equal(failed.error_code, "invalid_request");
	assert.deepEqual(failed.result, {
		message: "provider rejected the request",
		additional_details: "Invalid schema api_key=[REDACTED] (status 400)",
		diagnostics: {
			status: 400,
			provider_error_code: "invalid_function_parameters",
		},
	});
	assert.deepEqual(store.loadConversation("session-1"), [
		{ role: "user", content: "inspect the repository" },
	]);
	assert.deepEqual(
		store.loadHistoryItems("session-1").filter((item) => item.id === turnFailedNoticeId(failed.turn_id)),
		[{
			id: turnFailedNoticeId(failed.turn_id),
			thread_id: "session-1",
			turn_id: failed.turn_id,
			type: "error",
			text: turnFailureNotice(
				"invalid_request",
				"provider rejected the request",
			),
			tool_name: null,
			call_id: null,
			metadata: {
				event_kind: "turn_failed",
				failed_turn_id: failed.turn_id,
				status: "failed",
				code: "invalid_request",
				source: "runtime",
				additional_details: "Invalid schema api_key=[REDACTED] (status 400)",
			},
		}],
	);
	assert.doesNotMatch(JSON.stringify(failed), /private-value/u);
});

test("failing a turn closes every pending tool call before later replay", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => store.close());
	store.reserveTurn(submission(fixture.root));
	store.appendAssistantToolCalls({
		sessionId: "session-1",
		clientTurnId: "client-1",
		assistantText: "",
		calls: [{
			callId: "call-shell",
			name: "Shell",
			argumentsJson: "{\"command\":\"printf test\"}",
		}],
	});

	store.failTurn({
		sessionId: "session-1",
		clientTurnId: "client-1",
		code: "persistence_error",
		message: "session persistence failed",
		completedAt: LATER,
	});

	assert.deepEqual(store.loadConversationItems("session-1").at(-1), {
		type: "tool_result",
		callId: "call-shell",
		toolName: "Shell",
		output: "Tool result unavailable because the turn failed before persistence completed.",
		success: false,
	});
});

test("interrupting a turn closes every pending tool call as tool_interrupted", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => store.close());
	store.reserveTurn(submission(fixture.root));
	store.appendAssistantToolCalls({
		sessionId: "session-1",
		clientTurnId: "client-1",
		assistantText: "",
		calls: [{ callId: "call-read", name: "Read", argumentsJson: "{}" }],
	});

	const interrupted = store.failTurn({
		sessionId: "session-1",
		clientTurnId: "client-1",
		code: "interrupted",
		message: "turn interrupted",
		completedAt: LATER,
	});

	assert.equal(interrupted.status, "interrupted");
	const conversation = store.loadConversationItems("session-1");
	assert.deepEqual(conversation.at(-2), {
		type: "tool_result",
		callId: "call-read",
		toolName: "Read",
		output: "Tool execution was interrupted before a result was persisted.",
		success: false,
	});
	const marker = conversation.at(-1);
	assert.equal(marker?.type, "context");
	assert.equal(
		marker?.type === "context" ? marker.metadata.kind : undefined,
		"turn_aborted",
	);
	const database = await openDatabase(fixture.dbPath);
	t.after(() => database.close());
	const row = database.prepare(`
		SELECT payload_json FROM conversation_messages
		WHERE session_id = ? AND json_extract(payload_json, '$.role') = 'tool'
		ORDER BY message_index DESC LIMIT 1
	`).get("session-1") as { payload_json: string };
	const payload = JSON.parse(row.payload_json) as { metadata?: { error_kind?: string } };
	assert.equal(payload.metadata?.error_kind, "tool_interrupted");
	const notices = store.loadHistoryItems("session-1")
		.filter((item) => item.id === turnInterruptedNoticeId(interrupted.turn_id));
	assert.deepEqual(notices.map((item) => [item.type, item.text]), [
		["warning", TURN_INTERRUPTED_NOTICE],
	]);
	assert.equal(JSON.stringify(conversation).includes(TURN_INTERRUPTED_NOTICE), false);
});

test("targeted worker recovery persists pending results and one turn-aborted marker", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => store.close());
	const reservation = store.reserveTurn(submission(fixture.root));
	store.appendAssistantToolCalls({
		sessionId: "session-1",
		clientTurnId: "client-1",
		assistantText: "",
		calls: [{ callId: "call-shell", name: "Shell", argumentsJson: "{}" }],
	});

	const recovered = store.recoverInterruptedTurn(
		"session-1",
		reservation.turn.turn_id,
		true,
	);
	const recoveredAgain = store.recoverInterruptedTurn(
		"session-1",
		reservation.turn.turn_id,
		true,
	);

	assert.equal(recovered?.status, "interrupted");
	assert.equal(recoveredAgain?.status, "interrupted");
	const conversation = store.loadConversationItems("session-1");
	assert.deepEqual(conversation.filter((item) => item.type === "tool_result"), [{
		type: "tool_result",
		callId: "call-shell",
		toolName: "Shell",
		output: "Tool call interrupted before it completed.",
		success: false,
	}]);
	assert.equal(conversation.filter(
		(item) => item.type === "context" && item.metadata.kind === "turn_aborted",
	).length, 1);
	assert.equal(
		store.loadHistoryItems("session-1").filter(
			(item) => item.id === turnInterruptedNoticeId(reservation.turn.turn_id),
		).length,
		1,
	);
});

test("targeted recovery terminalizes started effects once with exact canonical outcomes", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => store.close());
	const reservation = store.reserveTurn(submission(fixture.root));
	store.appendAssistantToolCalls({
		sessionId: "session-1",
		clientTurnId: "client-1",
		assistantText: "",
		calls: [
			{ callId: "call-completed", name: "Read", argumentsJson: "{}" },
			{ callId: "call-read", name: "Read", argumentsJson: "{}" },
			{ callId: "call-write", name: "Write", argumentsJson: "{}" },
			{ callId: "call-queued", name: "Read", argumentsJson: "{}" },
		],
	});
	for (const attempt of [
		effectAttempt("attempt-completed", "call-completed", "Read", false),
		effectAttempt("attempt-read", "call-read", "Read", false),
		effectAttempt("attempt-write", "call-write", "Write", true),
	]) {
		store.agentEffectLedger.reserve(attempt);
	}
	store.agentEffectLedger.complete({
		attemptId: "attempt-completed",
		state: "completed",
		result: {
			callId: "call-completed",
			toolName: "Read",
			success: true,
			modelOutput: "committed contents",
			images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
			summary: "Read completed",
			metadata: {},
		},
		completedAt: LATER,
	});

	store.recoverInterruptedTurn("session-1", reservation.turn.turn_id, true);
	store.recoverInterruptedTurn("session-1", reservation.turn.turn_id, true);

	assert.equal(store.agentEffectLedger.load("attempt-completed")?.state, "completed");
	assert.equal(store.agentEffectLedger.load("attempt-read")?.state, "interrupted");
	assert.equal(store.agentEffectLedger.load("attempt-write")?.state, "effect_outcome_unknown");
	assert.throws(() => store.agentEffectLedger.complete({
		attemptId: "attempt-write",
		state: "completed",
		result: { callId: "call-write" },
		completedAt: LATER,
	}), /different terminal outcome/u);

	const database = await openDatabase(fixture.dbPath);
	t.after(() => database.close());
	const rows = database.prepare(`
		SELECT payload_json FROM conversation_messages
		WHERE session_id = ? AND json_extract(payload_json, '$.role') = 'tool'
		ORDER BY message_index
	`).all("session-1") as readonly { payload_json: string }[];
	const results = rows.map((row) => JSON.parse(row.payload_json) as {
		tool_call_id: string;
		content: string;
		metadata?: { error_kind?: string };
	});
	assert.deepEqual(results.map((result) => [
		result.tool_call_id,
		result.content,
		result.metadata?.error_kind,
	]), [
		["call-completed", "committed contents", undefined],
		["call-read", "Tool execution was interrupted before a result was persisted.", "tool_interrupted"],
		["call-write", "Tool outcome is unknown because interruption occurred after the effect started.", "effect_outcome_unknown"],
		["call-queued", "Tool call interrupted before it completed.", "tool_interrupted"],
	]);
	assert.equal(count(database, "agent_effect_attempt_outcomes"), 3);
	const recoveredImage = store.loadConversationItems("session-1").find((item) => item.type === "tool_result" && item.callId === "call-completed");
	assert.ok(recoveredImage?.type === "tool_result");
	assert.deepEqual(recoveredImage.images, [{ mediaType: "image/png", data: "aW1hZ2U=" }]);
});

test("targeted worker recovery leaves a completed turn unchanged", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => store.close());
	const reservation = store.reserveTurn(submission(fixture.root));
	store.completeTurn({
		sessionId: "session-1",
		clientTurnId: "client-1",
		assistantText: "done",
		usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		completedAt: LATER,
	});
	const before = store.loadConversationItems("session-1");

	const recovered = store.recoverInterruptedTurn(
		"session-1",
		reservation.turn.turn_id,
		true,
	);

	assert.equal(recovered?.status, "completed");
	assert.deepEqual(store.loadConversationItems("session-1"), before);
});

test("replay synthesizes results for terminal legacy calls without changing active calls", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	store.reserveTurn(submission(fixture.root));
	store.appendAssistantToolCalls({
		sessionId: "session-1",
		clientTurnId: "client-1",
		assistantText: "",
		calls: [{ callId: "call-read", name: "Read", argumentsJson: "{}" }],
	});
	assert.equal(store.loadConversationItems("session-1").at(-1)?.type, "assistant_tool_calls");
	store.failTurn({
		sessionId: "session-1",
		clientTurnId: "client-1",
		code: "persistence_error",
		message: "session persistence failed",
		completedAt: LATER,
	});
	store.close();

	const database = await openDatabase(fixture.dbPath);
	database.prepare(`
		DELETE FROM conversation_messages
		WHERE session_id = ? AND json_extract(payload_json, '$.role') = 'tool'
	`).run("session-1");
	database.close();

	const reopened = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => reopened.close());
	assert.deepEqual(reopened.loadConversationItems("session-1").at(-1), {
		type: "tool_result",
		callId: "call-read",
		toolName: "Read",
		output: "Tool result unavailable because the previous turn ended before persistence completed.",
		success: false,
	});
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

test("round trips canonical user images without relying on the source file", async (t) => {
	const SQLiteSessionStore = constructor();
	const fixture = await databaseFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	store.reserveTurn({
		...submission(fixture.root),
		imagePaths: ["/tmp/source-image.png"],
		images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
	});
	store.close();

	const reopened = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: fixedClock });
	t.after(() => reopened.close());
	assert.deepEqual(reopened.loadConversationItems("session-1"), [{
		type: "user",
		text: "inspect the repository",
		images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
	}]);
	const userHistory = reopened.loadHistoryItems("session-1")[0];
	assert.deepEqual(
		(userHistory?.metadata as Readonly<Record<string, unknown>> | undefined)?.image_paths,
		["/tmp/source-image.png"],
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
		clientUserMessageId: "user-message-1",
		turnId: "turn-1",
		requestFingerprint: `sha256:${"a".repeat(64)}`,
		workspaceRoot,
		threadId: "session-1",
		userText: "inspect the repository",
		startedAt: NOW,
	};
}

function effectAttempt(
	attemptId: string,
	externalId: string,
	toolName: string,
	mutating: boolean,
): ReserveAgentEffectAttemptInput {
	return {
		attemptId,
		kind: "tool",
		sessionId: "session-1",
		turnId: "turn-1",
		jobId: "job-1",
		externalId,
		mutating,
		request: { tool_name: toolName, arguments_sha256: "b".repeat(64), mutating },
		createdAt: NOW,
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
