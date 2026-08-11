import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeTurnRecord } from "@mycli/contracts";
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
import * as storage from "../src/index.ts";

interface ReserveTurnInput {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly clientUserMessageId: string;
	readonly turnId: string;
	readonly requestFingerprint: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly userText: string;
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
	readonly diagnostics?: Readonly<Record<string, string | number | boolean | null>>;
	readonly completedAt: string;
}

interface Store {
	reserveTurn(input: ReserveTurnInput): {
		readonly kind: "reserved" | "existing";
		readonly turn: RuntimeTurnRecord;
	};
	loadTurn(sessionId: string, clientTurnId: string): RuntimeTurnRecord | undefined;
	loadConversation(sessionId: string): readonly CanonicalMessage[];
	loadConversationItems(sessionId: string): readonly CanonicalConversationItem[];
	loadHistoryItems(sessionId: string): readonly Readonly<Record<string, unknown>>[];
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

test("initializes the complete schema-v6 shape plus durable model-input state", async (t) => {
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
	]) {
		assert.ok(tables.includes(table), `missing table ${table}`);
	}
	for (const trigger of [
		"conversation_messages_fts_delete",
		"conversation_messages_fts_insert",
		"conversation_messages_fts_update",
		"history_items_fts_delete",
		"history_items_fts_insert",
		"history_items_fts_update",
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
	]) {
		assert.ok(triggers.includes(trigger), `missing trigger ${trigger}`);
	}
	assert.equal((database.prepare("SELECT version FROM schema_version").get() as { version: number }).version, 6);
	const runtimeTurnColumns = database.prepare("PRAGMA table_info(runtime_turns)").all()
		.map((row) => String((row as { name: unknown }).name));
	assert.ok(runtimeTurnColumns.includes("owner_id"));
	assert.ok(runtimeTurnColumns.includes("owner_pid"));
	assert.equal(storage.SCHEMA_VERSION, 6);
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
			6,
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
			6,
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
		6,
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
		6,
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
		provider: "openai",
		value: { thinking: "checked", signature: "sig-test" },
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
		diagnostics: {
			status: 400,
			provider_error_code: "invalid_function_parameters",
		},
		completedAt: LATER,
	});

	assert.equal(failed.status, "failed");
	assert.equal(failed.error_code, "provider_error");
	assert.deepEqual(failed.result, {
		message: "provider request failed",
		diagnostics: {
			status: 400,
			provider_error_code: "invalid_function_parameters",
		},
	});
	assert.deepEqual(store.loadConversation("session-1"), [
		{ role: "user", content: "inspect the repository" },
	]);
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
