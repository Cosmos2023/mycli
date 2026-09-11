import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	analyzeV9TranscriptNormalization,
	SQLiteSessionStore,
	stageV9TranscriptNormalizationBatch,
	StorageFailure,
	V9_TRANSCRIPT_NORMALIZATION_MINIMUM_FREE_BYTES,
	type V9TranscriptNormalizationStagingBatchResult,
} from "../../../src/index.ts";
import { createVersionedLegacyNormalizationFixture } from "../../support/v9-normalization-fixtures.ts";

const NOW = "2026-08-14T00:00:00.000Z";
const WORKSPACE_ROOT = "/workspace";

test("rolls back an interrupted batch and retries without duplicate source mappings", async (t) => {
	const fixture = await databaseFixture(t, "interruption");
	seedFixture(fixture.dbPath);
	const first = stage(fixture.dbPath, 1);
	assert.equal(first.totalStagedSourceRowCount, 1);
	const before = stagingCounts(fixture.dbPath);
	const database = new Database(fixture.dbPath);
	database.exec(`
		CREATE TRIGGER fail_normalization_source_map
		BEFORE INSERT ON transcript_normalization_source_map BEGIN
			SELECT RAISE(ABORT, 'injected normalization interruption');
		END
	`);
	database.close();

	assert.throws(
		() => stage(fixture.dbPath, 2),
		(error: unknown) => error instanceof StorageFailure
			&& !error.message.includes("injected normalization interruption"),
	);
	assert.deepEqual(stagingCounts(fixture.dbPath), before);
	const repair = new Database(fixture.dbPath);
	repair.exec("DROP TRIGGER fail_normalization_source_map");
	repair.close();

	const retried = stage(fixture.dbPath, 2);
	assert.equal(retried.selectedSourceRowCount, 2);
	assert.equal(retried.totalStagedSourceRowCount, 3);
	const completed = drain(fixture.dbPath, 2);
	assert.equal(completed.complete, true);
	const stable = stagingSnapshot(fixture.dbPath);
	for (let index = 0; index < 2; index += 1) {
		const idempotent = stage(fixture.dbPath, 2);
		assert.equal(idempotent.batchId, null);
		assert.equal(idempotent.selectedSourceRowCount, 0);
		assert.deepEqual(stagingSnapshot(fixture.dbPath), stable);
	}
});

test("consumes new legacy tail rows after a completed staging pass", async (t) => {
	const fixture = await databaseFixture(t, "tail");
	seedFixture(fixture.dbPath);
	const initial = drain(fixture.dbPath, 3);
	assert.equal(initial.complete, true);
	const before = legacySourceCount(fixture.dbPath);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: () => NOW });
	try {
		seedCompletedTurn(store, "tail-session", "second", true);
	} finally {
		store.close();
	}
	const after = legacySourceCount(fixture.dbPath);
	assert.ok(after > before);
	const dryRun = analyzeV9TranscriptNormalization({ dbPath: fixture.dbPath, batchSize: 2 });
	assert.equal(dryRun.batchProgress.remainingSourceRowCount, after - before);

	let selected = 0;
	for (;;) {
		const batch = stage(fixture.dbPath, 2);
		selected += batch.selectedSourceRowCount;
		if (batch.complete) break;
	}
	assert.equal(selected, after - before);
	assert.equal(mappedSourceCount(fixture.dbPath), after);
	assertNoDuplicateSources(fixture.dbPath);
	assert.equal(
		analyzeV9TranscriptNormalization({ dbPath: fixture.dbPath }).batchProgress.remainingSourceRowCount,
		0,
	);
});

test("serializes bounded batches from two independent processes", async (t) => {
	const fixture = await databaseFixture(t, "processes");
	seedFixture(fixture.dbPath);
	const [left, right] = await Promise.all([
		runStageProcess(fixture.dbPath, 2),
		runStageProcess(fixture.dbPath, 2),
	]);
	assert.equal(left.selectedSourceRowCount, 2);
	assert.equal(right.selectedSourceRowCount, 2);
	assert.deepEqual([left.batchId, right.batchId].sort(), [1, 2]);
	assert.equal(mappedSourceCount(fixture.dbPath), 4);
	assert.equal(stagingCounts(fixture.dbPath).batches, 2);
	assertNoDuplicateSources(fixture.dbPath);
	assert.equal(scalarAtPath(fixture.dbPath, "SELECT version FROM schema_version"), 9);
});

test("returns a bounded busy error while another writer owns BEGIN IMMEDIATE", async (t) => {
	const fixture = await databaseFixture(t, "busy");
	seedFixture(fixture.dbPath);
	const lock = new Database(fixture.dbPath);
	lock.exec("BEGIN IMMEDIATE");
	try {
		assert.throws(
			() => stageV9TranscriptNormalizationBatch({
				dbPath: fixture.dbPath,
				batchSize: 1,
				busyTimeoutMs: 0,
			}),
			(error: unknown) => error instanceof StorageFailure
				&& error.message.endsWith("database is busy")
				&& typeof error.diagnostics.sqlite_code === "string"
				&& !error.message.includes(fixture.dbPath),
		);
		assert.equal(normalizationObjectCount(fixture.dbPath), 0);
	} finally {
		lock.exec("ROLLBACK");
		lock.close();
	}
	assert.equal(stage(fixture.dbPath, 1).selectedSourceRowCount, 1);
});

test("rejects low disk before opening a staging transaction", async (t) => {
	const fixture = await databaseFixture(t, "disk");
	seedFixture(fixture.dbPath);
	assert.throws(
		() => stageV9TranscriptNormalizationBatch({
			dbPath: fixture.dbPath,
			batchSize: 1,
			freeSpaceProbe: () => V9_TRANSCRIPT_NORMALIZATION_MINIMUM_FREE_BYTES - 1,
		}),
		(error: unknown) => error instanceof StorageFailure
			&& error.message.endsWith("insufficient free space for transcript normalization")
			&& error.diagnostics.required_free_bytes
				=== V9_TRANSCRIPT_NORMALIZATION_MINIMUM_FREE_BYTES
			&& error.diagnostics.available_free_bytes
				=== V9_TRANSCRIPT_NORMALIZATION_MINIMUM_FREE_BYTES - 1
			&& !JSON.stringify(error.diagnostics).includes(fixture.dbPath),
	);
	assert.equal(normalizationObjectCount(fixture.dbPath), 0);
	assert.equal(stageV9TranscriptNormalizationBatch({
		dbPath: fixture.dbPath,
		batchSize: 1,
		freeSpaceProbe: () => V9_TRANSCRIPT_NORMALIZATION_MINIMUM_FREE_BYTES,
	}).selectedSourceRowCount, 1);
});

test("detects a changed mapped source hash and resumes after exact restoration", async (t) => {
	const fixture = await databaseFixture(t, "source-conflict");
	seedFixture(fixture.dbPath);
	stage(fixture.dbPath, 1);
	const database = new Database(fixture.dbPath);
	const mapped = database.prepare(`
		SELECT mapped.source_rowid, source.payload_json
		FROM transcript_normalization_source_map AS mapped
		JOIN conversation_messages AS source ON source.rowid = mapped.source_rowid
		WHERE mapped.source_kind = 'conversation_messages'
		LIMIT 1
	`).get() as { readonly source_rowid: number; readonly payload_json: string };
	database.prepare(`
		UPDATE conversation_messages SET payload_json = ? WHERE rowid = ?
	`).run("{\"changed\":true}", mapped.source_rowid);
	database.close();
	const before = stagingCounts(fixture.dbPath);

	assert.throws(
		() => stage(fixture.dbPath, 2),
		(error: unknown) => error instanceof StorageFailure
			&& error.message.endsWith("transcript normalization source changed after staging")
			&& error.diagnostics.source_kind === "conversation_messages"
			&& !JSON.stringify(error.diagnostics).includes("tail-session"),
	);
	assert.deepEqual(stagingCounts(fixture.dbPath), before);
	const restore = new Database(fixture.dbPath);
	restore.prepare("UPDATE conversation_messages SET payload_json = ? WHERE rowid = ?")
		.run(mapped.payload_json, mapped.source_rowid);
	restore.close();
	assert.equal(stage(fixture.dbPath, 2).selectedSourceRowCount, 2);
});

function seedFixture(dbPath: string): void {
	createVersionedLegacyNormalizationFixture({
		dbPath,
		workspaceRoot: WORKSPACE_ROOT,
		sourceSchemaVersion: 9,
	});
}

function seedCompletedTurn(
	store: SQLiteSessionStore,
	sessionId: string,
	suffix: string,
	withTool: boolean,
): void {
	const clientTurnId = `${sessionId}-client-${suffix}`;
	store.reserveTurn({
		sessionId,
		clientTurnId,
		clientUserMessageId: `${sessionId}-user-${suffix}`,
		turnId: `${sessionId}-turn-${suffix}`,
		requestFingerprint: `sha256:${"c".repeat(64)}`,
		workspaceRoot: WORKSPACE_ROOT,
		threadId: sessionId,
		userText: `${suffix} request`,
		startedAt: NOW,
	});
	if (withTool) {
		store.appendAssistantToolCalls({
			sessionId,
			clientTurnId,
			assistantText: "Inspecting.",
			calls: [{
				callId: `${sessionId}-call-${suffix}`,
				name: "Read",
				argumentsJson: "{}",
			}],
		});
		store.appendToolResult({
			sessionId,
			clientTurnId,
			result: {
				callId: `${sessionId}-call-${suffix}`,
				toolName: "Read",
				output: `${suffix} output`,
				success: true,
			},
			summary: "Read complete",
		});
	}
	store.completeTurn({
		sessionId,
		clientTurnId,
		assistantText: `${suffix} complete`,
		usage: {},
		completedAt: NOW,
	});
}

function stage(dbPath: string, batchSize: number): V9TranscriptNormalizationStagingBatchResult {
	return stageV9TranscriptNormalizationBatch({
		dbPath,
		batchSize,
		clock: () => NOW,
	});
}

function drain(dbPath: string, batchSize: number): V9TranscriptNormalizationStagingBatchResult {
	for (let index = 0; index < 100; index += 1) {
		const result = stage(dbPath, batchSize);
		if (result.complete) return result;
	}
	throw new Error("normalization fixture did not converge");
}

async function runStageProcess(
	dbPath: string,
	batchSize: number,
): Promise<V9TranscriptNormalizationStagingBatchResult> {
	const fixturePath = join(
		import.meta.dirname,
		"..",
		"..",
		"fixtures",
		"v9-normalization-stage-process.mjs",
	);
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [
			"--import",
			"tsx",
			fixturePath,
			dbPath,
			String(batchSize),
		], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code !== 0) {
				reject(new Error(`staging process failed with code ${String(code)}: ${stderr.slice(0, 200)}`));
				return;
			}
			resolve(JSON.parse(stdout) as V9TranscriptNormalizationStagingBatchResult);
		});
	});
}

function stagingCounts(dbPath: string): Readonly<{
	readonly batches: number;
	readonly events: number;
	readonly mappings: number;
}> {
	const database = new Database(dbPath, { readonly: true });
	try {
		return Object.freeze({
			batches: scalar(database, "SELECT COUNT(*) FROM transcript_normalization_batches"),
			events: scalar(database, "SELECT COUNT(*) FROM transcript_normalization_events"),
			mappings: scalar(database, "SELECT COUNT(*) FROM transcript_normalization_source_map"),
		});
	} finally {
		database.close();
	}
}

function stagingSnapshot(dbPath: string): readonly unknown[] {
	const database = new Database(dbPath, { readonly: true });
	try {
		return Object.freeze([
			database.prepare("SELECT * FROM transcript_normalization_batches ORDER BY batch_id").all(),
			database.prepare(`
				SELECT * FROM transcript_normalization_events ORDER BY session_id, event_id
			`).all(),
			database.prepare(`
				SELECT * FROM transcript_normalization_source_map ORDER BY source_kind, source_rowid
			`).all(),
		]);
	} finally {
		database.close();
	}
}

function legacySourceCount(dbPath: string): number {
	const database = new Database(dbPath, { readonly: true });
	try {
		return ["conversation_messages", "history_items", "turn_rollouts", "session_summaries"]
			.reduce((total, table) => total + scalar(database, `SELECT COUNT(*) FROM ${table}`), 0);
	} finally {
		database.close();
	}
}

function mappedSourceCount(dbPath: string): number {
	return scalarAtPath(dbPath, "SELECT COUNT(*) FROM transcript_normalization_source_map");
}

function normalizationObjectCount(dbPath: string): number {
	return scalarAtPath(dbPath, `
		SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'transcript_normalization_%'
	`);
}

function assertNoDuplicateSources(dbPath: string): void {
	const database = new Database(dbPath, { readonly: true });
	try {
		assert.equal(scalar(database, `
			SELECT COUNT(*) FROM (
				SELECT source_kind, source_rowid, COUNT(*) AS copies
				FROM transcript_normalization_source_map
				GROUP BY source_kind, source_rowid HAVING copies > 1
			)
		`), 0);
	} finally {
		database.close();
	}
}

function scalarAtPath(dbPath: string, sql: string): number {
	const database = new Database(dbPath, { readonly: true });
	try {
		return scalar(database, sql);
	} finally {
		database.close();
	}
}

function scalar(database: Database.Database, sql: string): number {
	return Number(database.prepare(sql).pluck().get());
}

async function databaseFixture(t: test.TestContext, name: string): Promise<{
	readonly root: string;
	readonly dbPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), `mycli-v9-staging-${name}-`));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return { root, dbPath: join(root, "sessions.db") };
}
