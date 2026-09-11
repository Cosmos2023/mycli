import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	analyzeV9TranscriptNormalization,
	createV9ProjectionManifest,
	parseTranscriptEventEnvelope,
	projectTranscriptEventsToProviderItems,
	SQLiteSessionStore,
	stageV9TranscriptNormalizationBatch,
	StorageFailure,
	type TranscriptEventEnvelope,
	type V9TranscriptNormalizationStagingBatchResult,
} from "../../../src/index.ts";
import {
	createRichV9NormalizationFixture,
	MALFORMED_CONVERSATION_PAYLOAD,
	RICH_V9_SESSION_IDS,
} from "../../support/v9-normalization-fixtures.ts";

const NOW = "2026-08-14T00:00:00.000Z";

test("stages bounded reconciled batches while schema v9 and legacy projections remain authoritative", async (t) => {
	const fixture = await databaseFixture(t, "bounded");
	createRichV9NormalizationFixture({ dbPath: fixture.dbPath, workspaceRoot: fixture.root });
	const beforeManifest = createV9ProjectionManifest({ dbPath: fixture.dbPath });
	const beforeLegacy = legacyShape(fixture.dbPath);
	const beforeDryRun = analyzeV9TranscriptNormalization({ dbPath: fixture.dbPath, batchSize: 3 });

	const first = stageV9TranscriptNormalizationBatch({
		dbPath: fixture.dbPath,
		batchSize: 3,
		clock: () => NOW,
	});
	assert.equal(first.schemaVersion, 9);
	assert.equal(first.stagingSchemaVersion, 1);
	assert.equal(first.batchId, 1);
	assert.equal(first.selectedSourceRowCount, 3);
	assert.ok(first.stagedEventCount <= 3);
	assert.equal(first.totalStagedSourceRowCount, 3);
	assert.equal(first.complete, false);

	const partialDryRun = analyzeV9TranscriptNormalization({ dbPath: fixture.dbPath, batchSize: 3 });
	assert.equal(partialDryRun.batchProgress.completedBatchCount, 1);
	assert.equal(partialDryRun.batchProgress.stagedSourceRowCount, 3);
	assert.equal(
		partialDryRun.batchProgress.remainingSourceRowCount,
		beforeDryRun.batchProgress.eligibleSourceRowCount - 3,
	);

	const batches = drain(fixture.dbPath, 3);
	assert.ok(batches.length > 1);
	assert.ok(batches.every((batch) => batch.selectedSourceRowCount <= 3));
	assert.equal(batches.at(-1)?.complete, true);
	assert.equal(batches.at(-1)?.remainingSourceRowCount, 0);
	assert.ok(batches.reduce((total, batch) => total + batch.mergedSourceRowCount, 0) > 0);
	assert.ok(batches.reduce((total, batch) => total + batch.opaqueSourceRowCount, 0) >= 8);

	const database = new Database(fixture.dbPath, { readonly: true });
	try {
		const marker = database.prepare("SELECT version FROM schema_version").pluck().get();
		assert.equal(marker, 9);
		assert.deepEqual(legacyShape(fixture.dbPath), beforeLegacy);
		const mapped = scalar(database, "SELECT COUNT(*) FROM transcript_normalization_source_map");
		const events = scalar(database, "SELECT COUNT(*) FROM transcript_normalization_events");
		assert.equal(mapped, beforeDryRun.batchProgress.eligibleSourceRowCount);
		assert.ok(events < mapped);
		assert.equal(scalar(database, `
			SELECT COUNT(*) FROM transcript_normalization_source_map
			WHERE session_id = ?
		`, RICH_V9_SESSION_IDS.activeRecovery), 0);

		const toolEventIds = database.prepare(`
			SELECT merge_key, event_id FROM transcript_normalization_merge_keys
			WHERE session_id = ? AND merge_key IN (?, ?)
			ORDER BY merge_key
		`).all(
			RICH_V9_SESSION_IDS.node,
			"tool-call:node-call-grep",
			"tool-call:node-call-read",
		) as readonly { readonly merge_key: string; readonly event_id: string }[];
		assert.equal(toolEventIds.length, 2);
		assert.equal(new Set(toolEventIds.map((row) => row.event_id)).size, 1);
		const toolBatch = stagedPayload(database, RICH_V9_SESSION_IDS.node, toolEventIds[0]!.event_id);
		assert.equal(toolBatch.event_type, "assistant_tool_call_batch");
		assert.deepEqual(
			(recordValue(toolBatch.payload).calls as readonly Readonly<Record<string, unknown>>[])
				.map((call) => call.callId),
			["node-call-read", "node-call-grep"],
		);

		const compactionSummary = database.prepare(`
			SELECT event_id FROM transcript_normalization_merge_keys
			WHERE session_id = ? AND merge_key = 'summary:2'
		`).pluck().get(RICH_V9_SESSION_IDS.repeatedCompaction);
		assert.equal(typeof compactionSummary, "string");
		assert.equal(
			database.prepare(`
				SELECT event_type FROM transcript_normalization_events
				WHERE session_id = ? AND event_id = ?
			`).pluck().get(RICH_V9_SESSION_IDS.repeatedCompaction, compactionSummary),
			"compaction",
		);
		assert.equal(scalar(database, `
			SELECT COUNT(*) FROM transcript_normalization_source_map
			WHERE session_id = ? AND event_id = ? AND source_kind IN (
				'history_items', 'session_summaries'
			)
		`, RICH_V9_SESSION_IDS.repeatedCompaction, compactionSummary), 2);

		const malformedEventId = database.prepare(`
			SELECT event_id FROM transcript_normalization_source_map
			WHERE session_id = ? AND source_kind = 'conversation_messages'
		`).pluck().get(RICH_V9_SESSION_IDS.malformedConversation);
		const malformed = stagedPayload(
			database,
			RICH_V9_SESSION_IDS.malformedConversation,
			String(malformedEventId),
		);
		assert.equal(malformed.event_type, "opaque_legacy");
		assert.equal(recordValue(malformed.payload).rawPayload, MALFORMED_CONVERSATION_PAYLOAD);
		assert.equal(recordValue(malformed.payload).errorCode, "invalid_json");
		assert.equal(malformed.model_visible, 1);
	} finally {
		database.close();
	}
	const legacyStore = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: () => NOW });
	try {
		for (const sessionId of [
			RICH_V9_SESSION_IDS.node,
			RICH_V9_SESSION_IDS.python,
			RICH_V9_SESSION_IDS.conversationOnly,
			RICH_V9_SESSION_IDS.historyOnly,
			RICH_V9_SESSION_IDS.forkParent,
			RICH_V9_SESSION_IDS.forkChild,
		]) {
			assert.deepEqual(
				stagedProviderItems(fixture.dbPath, sessionId),
				legacyStore.loadConversationItems(sessionId),
			);
		}
	} finally {
		legacyStore.close();
	}

	const afterManifest = createV9ProjectionManifest({ dbPath: fixture.dbPath });
	assert.deepEqual(afterManifest, beforeManifest);
	const completeDryRun = analyzeV9TranscriptNormalization({ dbPath: fixture.dbPath, batchSize: 3 });
	assert.equal(completeDryRun.batchProgress.stagedSourceRowCount, mappedSourceCount(fixture.dbPath));
	assert.equal(completeDryRun.batchProgress.remainingSourceRowCount, 0);
	assert.equal(
		completeDryRun.batchProgress.plannedBatchCount,
		completeDryRun.batchProgress.completedBatchCount,
	);
});

test("produces deterministic staging rows across independent rich fixtures", async (t) => {
	const left = await databaseFixture(t, "deterministic-left");
	const right = await databaseFixture(t, "deterministic-right");
	createRichV9NormalizationFixture({ dbPath: left.dbPath, workspaceRoot: "/workspace" });
	createRichV9NormalizationFixture({ dbPath: right.dbPath, workspaceRoot: "/workspace" });
	drain(left.dbPath, 5);
	drain(right.dbPath, 5);

	assert.deepEqual(stagingSnapshot(left.dbPath), stagingSnapshot(right.dbPath));
});

test("rejects non-v9 storage and invalid bounds without installing staging objects", async (t) => {
	const fixture = await databaseFixture(t, "rejection");
	const database = new Database(fixture.dbPath);
	database.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
	database.prepare("INSERT INTO schema_version (version) VALUES (8)").run();
	database.close();

	assert.throws(
		() => stageV9TranscriptNormalizationBatch({ dbPath: fixture.dbPath }),
		(error: unknown) => error instanceof StorageFailure
			&& error.diagnostics.expected_version === 9
			&& error.diagnostics.actual_version === 8
			&& !error.message.includes(fixture.dbPath),
	);
	const read = new Database(fixture.dbPath, { readonly: true });
	try {
		assert.equal(scalar(read, `
			SELECT COUNT(*) FROM sqlite_master
			WHERE name LIKE 'transcript_normalization_%'
		`), 0);
	} finally {
		read.close();
	}
	for (const batchSize of [0, -1, 10_001, 1.5]) {
		assert.throws(
			() => stageV9TranscriptNormalizationBatch({ dbPath: fixture.dbPath, batchSize }),
			/batchSize must be between 1 and 10000/u,
		);
	}
});

function drain(dbPath: string, batchSize: number): readonly V9TranscriptNormalizationStagingBatchResult[] {
	const batches: V9TranscriptNormalizationStagingBatchResult[] = [];
	for (let index = 0; index < 1_000; index += 1) {
		const result = stageV9TranscriptNormalizationBatch({
			dbPath,
			batchSize,
			clock: () => NOW,
		});
		if (result.batchId !== null) batches.push(result);
		if (result.complete) return Object.freeze(batches);
	}
	throw new Error("normalization fixture did not converge");
}

function legacyShape(dbPath: string): Readonly<Record<string, unknown>> {
	const database = new Database(dbPath, { readonly: true });
	try {
		return Object.freeze({
			version: database.prepare("SELECT version FROM schema_version").pluck().get(),
			tables: Object.freeze([
				"conversation_messages",
				"history_items",
				"turn_rollouts",
				"session_summaries",
			].map((table) => Object.freeze({
				table,
				rows: scalar(database, `SELECT COUNT(*) FROM ${table}`),
			}))),
			ftsObjects: scalar(database, `
				SELECT COUNT(*) FROM sqlite_master
				WHERE name IN (
					'conversation_messages_fts',
					'conversation_messages_fts_insert',
					'conversation_messages_fts_delete',
					'conversation_messages_fts_update'
				)
			`),
		});
	} finally {
		database.close();
	}
}

function stagingSnapshot(dbPath: string): Readonly<Record<string, unknown>> {
	const database = new Database(dbPath, { readonly: true });
	try {
		return Object.freeze({
			events: database.prepare(`
				SELECT * FROM transcript_normalization_events
				ORDER BY session_id, event_id
			`).all(),
			sourceMap: database.prepare(`
				SELECT * FROM transcript_normalization_source_map
				ORDER BY source_kind, source_rowid
			`).all(),
			mergeKeys: database.prepare(`
				SELECT * FROM transcript_normalization_merge_keys
				ORDER BY session_id, merge_key
			`).all(),
			batches: database.prepare(`
				SELECT * FROM transcript_normalization_batches ORDER BY batch_id
			`).all(),
		});
	} finally {
		database.close();
	}
}

function stagedPayload(
	database: Database.Database,
	sessionId: string,
	eventId: string,
): Readonly<{
	readonly event_type: unknown;
	readonly model_visible: unknown;
	readonly payload: unknown;
}> {
	const row = database.prepare(`
		SELECT event_type, model_visible, payload_json
		FROM transcript_normalization_events
		WHERE session_id = ? AND event_id = ?
	`).get(sessionId, eventId) as {
		readonly event_type: unknown;
		readonly model_visible: unknown;
		readonly payload_json: unknown;
	} | undefined;
	assert.ok(row);
	const stored = JSON.parse(String(row.payload_json)) as Readonly<Record<string, unknown>>;
	return Object.freeze({
		event_type: row.event_type,
		model_visible: row.model_visible,
		payload: stored.payload,
	});
}

function stagedProviderItems(
	dbPath: string,
	sessionId: string,
): readonly unknown[] {
	const database = new Database(dbPath, { readonly: true });
	try {
		const rows = database.prepare(`
			SELECT event_id, turn_id, event_type, provider_index, model_visible,
			       payload_json, created_at
			FROM transcript_normalization_events
			WHERE session_id = ? AND model_visible = 1
			ORDER BY provider_index, event_id
		`).all(sessionId) as readonly {
			readonly event_id: unknown;
			readonly turn_id: unknown;
			readonly event_type: unknown;
			readonly provider_index: unknown;
			readonly model_visible: unknown;
			readonly payload_json: unknown;
			readonly created_at: unknown;
		}[];
		const events = rows.map((row, index) => {
			const stored = JSON.parse(String(row.payload_json)) as Readonly<Record<string, unknown>>;
			return parseTranscriptEventEnvelope({
				schemaVersion: stored.schemaVersion,
				sequenceNo: index + 1,
				sessionId,
				eventId: row.event_id,
				...(typeof row.turn_id === "string" ? { turnId: row.turn_id } : {}),
				eventType: row.event_type,
				providerIndex: row.provider_index,
				modelVisible: row.model_visible === 1,
				createdAt: row.created_at,
				payload: stored.payload,
			});
		});
		return projectTranscriptEventsToProviderItems(events as readonly TranscriptEventEnvelope[]);
	} finally {
		database.close();
	}
}

function mappedSourceCount(dbPath: string): number {
	const database = new Database(dbPath, { readonly: true });
	try {
		return scalar(database, "SELECT COUNT(*) FROM transcript_normalization_source_map");
	} finally {
		database.close();
	}
}

function scalar(database: Database.Database, sql: string, ...parameters: readonly unknown[]): number {
	return Number(database.prepare(sql).pluck().get(...parameters));
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Readonly<Record<string, unknown>>
		: {};
}

async function databaseFixture(t: test.TestContext, name: string): Promise<{
	readonly root: string;
	readonly dbPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), `mycli-v9-normalization-${name}-`));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return { root, dbPath: join(root, "sessions.db") };
}
