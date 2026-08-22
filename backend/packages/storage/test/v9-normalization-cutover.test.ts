import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import {
	applyV9TranscriptNormalizationCutover,
	createV9ProjectionManifest,
	SQLiteSessionStore,
	SQLiteTranscriptEventRepository,
	stageV9TranscriptNormalizationBatch,
	StorageFailure,
	V9_TRANSCRIPT_NORMALIZATION_CUTOVER_STAGES,
} from "../src/index.ts";
import {
	createRichV9NormalizationFixture,
	RICH_V9_SESSION_IDS,
} from "./support/v9-normalization-fixtures.ts";

const NOW = "2026-08-14T00:00:00.000Z";
const REQUEST_FINGERPRINT = `sha256:${"d".repeat(64)}`;

test("refuses atomic cutover while an active recovery session remains", async (t) => {
	const fixture = await databaseFixture(t, "active");
	createRichV9NormalizationFixture({ dbPath: fixture.dbPath, workspaceRoot: fixture.root });
	stageInactiveSources(fixture.dbPath);

	assert.throws(
		() => applyV9TranscriptNormalizationCutover({
			dbPath: fixture.dbPath,
			clock: () => NOW,
		}),
		(error: unknown) => error instanceof StorageFailure
			&& error.message === "persistence_error: active recovery sessions block transcript normalization cutover"
			&& error.diagnostics.excluded_active_session_count === 1,
	);

	const database = new Database(fixture.dbPath, { readonly: true });
	assert.equal(database.prepare("SELECT version FROM schema_version").pluck().get(), 9);
	assert.equal(hasObject(database, "table", "conversation_messages"), true);
	assert.equal(hasObject(database, "table", "transcript_events"), false);
	assert.equal(database.prepare(`
		SELECT COUNT(*) FROM session_state
		WHERE session_id = ? AND state_key IN ('pending_decision', 'suspended_turn')
	`).pluck().get(RICH_V9_SESSION_IDS.activeRecovery), 2);
	assert.equal(database.prepare(`
		SELECT status FROM runtime_turns WHERE session_id = ?
	`).pluck().get(RICH_V9_SESSION_IDS.activeRecovery), "in_progress");
	database.close();
});

test("reconciles the tail and atomically installs validated schema v10", async (t) => {
	const fixture = await databaseFixture(t, "success");
	createRichV9NormalizationFixture({ dbPath: fixture.dbPath, workspaceRoot: fixture.root });
	resolveActiveRecovery(fixture.dbPath);
	seedProviderLedgerMarker(fixture.dbPath);
	stageAllSources(fixture.dbPath);
	appendTailTurn(fixture.dbPath, fixture.root);
	const legacy = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: () => NOW });
	const expectedChild = legacy.loadConversationItems(RICH_V9_SESSION_IDS.forkChild);
	const expectedTail = legacy.loadConversationItems("fixture-cutover-tail");
	legacy.close();
	installMarkerLastAssertion(fixture.dbPath);

	const result = applyV9TranscriptNormalizationCutover({
		dbPath: fixture.dbPath,
		tailBatchSize: 2,
		clock: () => NOW,
	});
	assert.equal(result.schemaVersion, 10);
	assert.ok(result.reconciledTailSourceRowCount > 0);
	assert.ok(result.tailBatchCount > 0);
	assert.ok(result.installedEventCount > 0);
	assert.ok(result.migratedLineageCount > 0);
	assert.ok(result.migratedCheckpointCount > 0);

	const database = new Database(fixture.dbPath, { readonly: true });
	assert.equal(database.prepare("SELECT version FROM schema_version").pluck().get(), 10);
	for (const legacyTable of [
		"conversation_messages",
		"history_items",
		"turn_rollouts",
		"session_summaries",
		"transcript_normalization_events",
		"transcript_normalization_source_map",
	]) assert.equal(hasObject(database, "table", legacyTable), false, legacyTable);
	assert.equal(hasObject(database, "table", "transcript_events"), true);
	assert.equal(hasObject(database, "table", "transcript_normalization_manifest"), true);
	assert.equal(
		database.prepare("SELECT payload_json FROM model_input_blobs WHERE blob_id = 'cutover-ledger-marker'")
			.pluck().get(),
		'{"private":"provider-ledger-marker"}',
	);
	assert.equal(database.prepare(`
		SELECT COUNT(*) FROM transcript_events
		WHERE session_id = ?
	`).pluck().get(RICH_V9_SESSION_IDS.forkChild), 0);
	const lineage = database.prepare(`
		SELECT fork_event_session_id, fork_event_id FROM conversation_trees WHERE session_id = ?
	`).get(RICH_V9_SESSION_IDS.forkChild) as {
		readonly fork_event_session_id: unknown;
		readonly fork_event_id: unknown;
	};
	assert.equal(lineage.fork_event_session_id, RICH_V9_SESSION_IDS.forkParent);
	assert.equal(typeof lineage.fork_event_id, "string");
	assert.equal(database.prepare(`
		SELECT event_type FROM transcript_events
		WHERE session_id = ? AND event_id = ?
	`).pluck().get(lineage.fork_event_session_id, lineage.fork_event_id), "turn_lifecycle");
	const checkpoint = JSON.parse(String(database.prepare(`
		SELECT payload_json FROM session_state
		WHERE session_id = ? AND state_key = 'compact_checkpoint'
	`).pluck().get(RICH_V9_SESSION_IDS.repeatedCompaction))) as Record<string, unknown>;
	assert.equal("replacement_messages" in checkpoint, false);
	assert.equal(typeof checkpoint.transcript_event_id, "string");
	const linkedCompactions = database.prepare(`
		SELECT json_extract(payload_json, '$.payload.sourceEventId') AS source_event_id
		FROM transcript_events
		WHERE session_id = ? AND event_type = 'compaction'
	`).all(RICH_V9_SESSION_IDS.repeatedCompaction) as readonly {
		readonly source_event_id: unknown;
	}[];
	assert.equal(linkedCompactions.length, 2);
	assert.equal(linkedCompactions.every((row) => typeof row.source_event_id === "string"), true);
	assert.ok(Number(database.prepare(`
		SELECT COUNT(*) FROM transcript_events_fts WHERE transcript_events_fts MATCH 'second'
	`).pluck().get()) > 0);
	database.close();

	const repository = new SQLiteTranscriptEventRepository({ dbPath: fixture.dbPath, clock: () => NOW });
	assert.deepEqual(repository.loadConversationItems(RICH_V9_SESSION_IDS.forkChild), expectedChild);
	assert.deepEqual(repository.loadConversationItems("fixture-cutover-tail"), expectedTail);
	assert.deepEqual(
		new Set(repository.searchMessages("parent turn", { limit: 100 }).map((row) => row.sessionId)),
		new Set([RICH_V9_SESSION_IDS.forkParent, RICH_V9_SESSION_IDS.forkChild]),
	);
	assert.equal(repository.searchMessages("history without", { limit: 100 }).some(
		(row) => row.sessionId === RICH_V9_SESSION_IDS.historyOnly,
	), false);
	assert.throws(
		() => repository.searchMessages("legacy_event", { limit: 100 }),
		(error: unknown) => error instanceof StorageFailure
			&& !error.message.includes("preserve-verbatim"),
	);
	assert.doesNotThrow(() => repository.validateRecoveryReferences(
		RICH_V9_SESSION_IDS.repeatedCompaction,
	));
	repository.close();
});

test("preserves a legacy assistant tool preamble id through cutover", async (t) => {
	const fixture = await databaseFixture(t, "legacy-preamble-id");
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: () => NOW });
	store.reserveTurn({
		sessionId: "legacy-preamble-session",
		clientTurnId: "legacy-preamble-client",
		clientUserMessageId: "legacy-preamble-user",
		turnId: "legacy-preamble-turn",
		requestFingerprint: REQUEST_FINGERPRINT,
		workspaceRoot: fixture.root,
		threadId: "legacy-preamble-session",
		userText: "inspect the fixture",
		startedAt: NOW,
	});
	store.appendAssistantToolCalls({
		sessionId: "legacy-preamble-session",
		clientTurnId: "legacy-preamble-client",
		assistantText: "legacy assistant preamble",
		calls: [{ callId: "legacy-preamble-call", name: "Read", argumentsJson: "{}" }],
	});
	store.appendToolResult({
		sessionId: "legacy-preamble-session",
		clientTurnId: "legacy-preamble-client",
		result: {
			callId: "legacy-preamble-call",
			toolName: "Read",
			output: "fixture output",
			success: true,
		},
		summary: "Read complete",
	});
	store.completeTurn({
		sessionId: "legacy-preamble-session",
		clientTurnId: "legacy-preamble-client",
		assistantText: "done",
		usage: {},
		completedAt: NOW,
	});
	store.close();

	const database = new Database(fixture.dbPath);
	database.prepare(`
		UPDATE history_items
		SET item_id = ?, payload_json = json_set(payload_json, '$.id', ?)
		WHERE session_id = ?
		  AND json_extract(payload_json, '$.type') = 'assistant_message'
		  AND json_extract(payload_json, '$.text') = 'legacy assistant preamble'
	`).run(
		"custom-legacy-preamble-id",
		"custom-legacy-preamble-id",
		"legacy-preamble-session",
	);
	database.close();

	stageAllSources(fixture.dbPath);
	assert.equal(applyV9TranscriptNormalizationCutover({ dbPath: fixture.dbPath }).schemaVersion, 10);
	const repository = new SQLiteTranscriptEventRepository({ dbPath: fixture.dbPath });
	try {
		const preamble = repository.loadReadableTranscript("legacy-preamble-session").find(
			(item) => item.text === "legacy assistant preamble",
		);
		assert.equal(preamble?.id, "custom-legacy-preamble-id");
	} finally {
		repository.close();
	}
});

test("merges repeated legacy users and orders provider-only assistant events", async (t) => {
	const fixture = await databaseFixture(t, "repeated-user-occurrence");
	const initialized = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: () => NOW });
	initialized.close();
	const sessionId = "legacy-repeated-user-session";
	const database = new Database(fixture.dbPath);
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at, updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, 'active')
	`).run(sessionId, fixture.root, sessionId, NOW, NOW, NOW);
	const insertConversation = database.prepare(`
		INSERT INTO conversation_messages (session_id, message_index, payload_json)
		VALUES (?, ?, ?)
	`);
	const insertHistory = database.prepare(`
		INSERT INTO history_items (session_id, item_id, payload_json) VALUES (?, ?, ?)
	`);
	insertHistory.run(sessionId, "history-only-preamble", JSON.stringify({
		id: "history-only-preamble",
		thread_id: sessionId,
		turn_id: "history-only-turn",
		type: "assistant_message",
		text: "repeated provider preamble",
		tool_name: null,
		call_id: null,
		metadata: {},
	}));
	let providerIndex = 0;
	for (let turn = 0; turn < 4; turn += 1) {
		const userText = turn < 3 ? "repeat this request" : "final request";
		const assistantText = `answer ${turn}`;
		insertConversation.run(sessionId, providerIndex, JSON.stringify({
			role: "user",
			content: userText,
			tool_call_id: null,
			response_id: null,
			metadata: {},
			blocks: [],
			tool_calls: [],
		}));
		providerIndex += 1;
		insertConversation.run(sessionId, providerIndex, JSON.stringify({
			role: "assistant",
			content: "repeated provider preamble",
			tool_call_id: null,
			response_id: null,
			metadata: {},
			blocks: [],
			tool_calls: [],
		}));
		providerIndex += 1;
		insertConversation.run(sessionId, providerIndex, JSON.stringify({
			role: "assistant",
			content: assistantText,
			tool_call_id: null,
			response_id: null,
			metadata: {},
			blocks: [],
			tool_calls: [],
		}));
		providerIndex += 1;
		for (const [suffix, type, text] of [
			["user", "user_message", userText],
			["assistant", "assistant_message", assistantText],
		] as const) {
			insertHistory.run(sessionId, `${suffix}-${turn}`, JSON.stringify({
				id: `${suffix}-${turn}`,
				thread_id: sessionId,
				turn_id: `turn-${turn}`,
				type,
				text,
				tool_name: null,
				call_id: null,
				metadata: {},
			}));
		}
	}
	database.close();

	const legacy = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: () => NOW });
	const expectedProvider = legacy.loadConversationItems(sessionId);
	const expectedReadableCount = legacy.loadHistoryItems(sessionId).length;
	legacy.close();
	stageAllSources(fixture.dbPath);
	assert.equal(applyV9TranscriptNormalizationCutover({ dbPath: fixture.dbPath }).schemaVersion, 10);

	const normalized = new SQLiteTranscriptEventRepository({ dbPath: fixture.dbPath, clock: () => NOW });
	assert.deepEqual(normalized.loadConversationItems(sessionId), expectedProvider);
	const readable = normalized.loadReadableTranscript(sessionId);
	assert.equal(readable.length, expectedReadableCount);
	assert.equal(readable.filter((item) => item.type === "user_message").length, 4);
	normalized.close();
});

test("preserves a legacy provider failure whose staged provider indices reset", async (t) => {
	const fixture = await databaseFixture(t, "provider-index-reset");
	createRichV9NormalizationFixture({ dbPath: fixture.dbPath, workspaceRoot: fixture.root });
	resolveActiveRecovery(fixture.dbPath);
	const sessionId = RICH_V9_SESSION_IDS.copiedRealProjectionFailures[0];
	const database = new Database(fixture.dbPath);
	database.prepare(`
		INSERT INTO conversation_messages (session_id, message_index, payload_json)
		VALUES (?, 7, ?)
	`).run(sessionId, JSON.stringify({
		role: "user",
		content: "sanitized readable fallback",
		tool_call_id: null,
		response_id: null,
		metadata: { turn_id: `${sessionId}-turn` },
		blocks: [],
		tool_calls: [],
	}));
	database.close();

	const legacy = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: () => NOW });
	assert.throws(() => legacy.loadConversationItems(sessionId), StorageFailure);
	legacy.close();
	stageAllSources(fixture.dbPath);
	assert.equal(applyV9TranscriptNormalizationCutover({ dbPath: fixture.dbPath }).schemaVersion, 10);

	const normalized = new SQLiteTranscriptEventRepository({ dbPath: fixture.dbPath, clock: () => NOW });
	assert.throws(() => normalized.loadConversationItems(sessionId), StorageFailure);
	normalized.close();
});

test("rolls back every final-cutover failpoint and retries from clean v9 state", async (t) => {
	for (const stage of V9_TRANSCRIPT_NORMALIZATION_CUTOVER_STAGES) {
		await t.test(stage, async (stageTest) => {
			const fixture = await databaseFixture(stageTest, stage);
			createRichV9NormalizationFixture({ dbPath: fixture.dbPath, workspaceRoot: fixture.root });
			resolveActiveRecovery(fixture.dbPath);
			seedProviderLedgerMarker(fixture.dbPath);
			stageAllSources(fixture.dbPath);
			const baseline = createV9ProjectionManifest({ dbPath: fixture.dbPath });
			const before = v9RetryShape(fixture.dbPath);

			assert.throws(
				() => applyV9TranscriptNormalizationCutover({
					dbPath: fixture.dbPath,
					clock: () => NOW,
					failpoint: (candidate) => {
						if (candidate === stage) throw new Error("injected cutover failure");
					},
				}),
				(error: unknown) => error instanceof StorageFailure
					&& error.message === "persistence_error: v9 transcript normalization cutover failed",
			);

			assert.deepEqual(v9RetryShape(fixture.dbPath), before);
			assert.deepEqual(createV9ProjectionManifest({ dbPath: fixture.dbPath }), baseline);
			const retried = applyV9TranscriptNormalizationCutover({
				dbPath: fixture.dbPath,
				clock: () => NOW,
			});
			assert.equal(retried.schemaVersion, 10);
			const database = new Database(fixture.dbPath, { readonly: true });
			assert.equal(database.prepare("SELECT version FROM schema_version").pluck().get(), 10);
			database.close();
		});
	}
});

function stageInactiveSources(dbPath: string): void {
	for (let index = 0; index < 1_000; index += 1) {
		const result = stageV9TranscriptNormalizationBatch({ dbPath, batchSize: 3, clock: () => NOW });
		if (result.selectedSourceRowCount === 0) return;
	}
	throw new Error("inactive staging did not converge");
}

function stageAllSources(dbPath: string): void {
	for (let index = 0; index < 1_000; index += 1) {
		const result = stageV9TranscriptNormalizationBatch({ dbPath, batchSize: 3, clock: () => NOW });
		if (result.complete) return;
	}
	throw new Error("staging did not converge");
}

function resolveActiveRecovery(dbPath: string): void {
	const database = new Database(dbPath);
	database.prepare("DELETE FROM session_state WHERE session_id = ?").run(RICH_V9_SESSION_IDS.activeRecovery);
	database.prepare(`
		UPDATE runtime_turns
		SET status = 'interrupted', error_code = 'interrupted', completed_at = ?,
		    owner_id = NULL, owner_pid = NULL
		WHERE session_id = ?
	`).run(NOW, RICH_V9_SESSION_IDS.activeRecovery);
	database.close();
}

function seedProviderLedgerMarker(dbPath: string): void {
	const database = new Database(dbPath);
	database.prepare(`
		INSERT INTO model_input_blobs (blob_id, payload_json, created_at) VALUES (?, ?, ?)
	`).run("cutover-ledger-marker", '{"private":"provider-ledger-marker"}', NOW);
	database.close();
}

function appendTailTurn(dbPath: string, workspaceRoot: string): void {
	const store = new SQLiteSessionStore({ dbPath, clock: () => NOW });
	store.reserveTurn({
		sessionId: "fixture-cutover-tail",
		clientTurnId: "tail-client",
		clientUserMessageId: "tail-user",
		turnId: "tail-turn",
		requestFingerprint: REQUEST_FINGERPRINT,
		workspaceRoot,
		threadId: "fixture-cutover-tail",
		userText: "tail input after staging",
		startedAt: NOW,
	});
	store.completeTurn({
		sessionId: "fixture-cutover-tail",
		clientTurnId: "tail-client",
		assistantText: "tail answer after staging",
		usage: {},
		completedAt: NOW,
	});
	store.close();
}

function installMarkerLastAssertion(dbPath: string): void {
	const database = new Database(dbPath);
	database.exec(`
		CREATE TRIGGER assert_normalization_marker_last
		BEFORE UPDATE OF version ON schema_version
		WHEN new.version = 10 AND (
			EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_messages')
			OR NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'transcript_events')
			OR NOT EXISTS (
				SELECT 1 FROM sqlite_master
				WHERE type = 'table' AND name = 'transcript_normalization_manifest'
			)
		)
		BEGIN
			SELECT RAISE(ABORT, 'schema marker was not written last');
		END;
	`);
	database.close();
}

function hasObject(database: Database.Database, type: "table" | "trigger", name: string): boolean {
	return database.prepare(`
		SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?
	`).get(type, name) !== undefined;
}

function v9RetryShape(dbPath: string): Readonly<Record<string, unknown>> {
	const database = new Database(dbPath, { readonly: true });
	try {
		return Object.freeze({
			version: database.prepare("SELECT version FROM schema_version").pluck().get(),
			legacyTables: Object.freeze([
				"conversation_messages",
				"history_items",
				"turn_rollouts",
				"session_summaries",
			].map((table) => hasObject(database, "table", table))),
			finalTable: hasObject(database, "table", "transcript_events"),
			manifestTable: hasObject(database, "table", "transcript_normalization_manifest"),
			lineageColumns: Object.freeze((database.prepare("PRAGMA table_info(conversation_trees)").all() as readonly {
				readonly name: unknown;
			}[]).map((row) => String(row.name))),
			checkpoint: database.prepare(`
				SELECT payload_json FROM session_state
				WHERE session_id = ? AND state_key = 'compact_checkpoint'
			`).pluck().get(RICH_V9_SESSION_IDS.repeatedCompaction),
			stagedSourceCount: database.prepare(`
				SELECT COUNT(*) FROM transcript_normalization_source_map
			`).pluck().get(),
			stagedEventCount: database.prepare(`
				SELECT COUNT(*) FROM transcript_normalization_events
			`).pluck().get(),
		});
	} finally {
		database.close();
	}
}

async function databaseFixture(t: TestContext, name: string): Promise<{
	readonly root: string;
	readonly dbPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), `mycli-v9-cutover-${name}-`));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return { root, dbPath: join(root, "sessions.db") };
}
