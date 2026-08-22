import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	discardV10ContentBlobMigrationStaging,
	stageV10ContentBlobMigrationBatch,
	StorageFailure,
	type V10ContentBlobMigrationStagingBatchResult,
} from "../src/index.ts";
import {
	appendV10ContentBlobMigrationTail,
	seedV10ContentBlobMigrationFixture,
	V10_CONTENT_MIGRATION_NOW,
} from "./support/v10-content-blob-migration-fixtures.ts";

test("rolls back an interrupted batch and retries without duplicate maps or content", async (t) => {
	const fixture = await databaseFixture(t, "interruption");
	seedV10ContentBlobMigrationFixture(fixture.dbPath);
	assert.equal(stage(fixture.dbPath, 1).selectedSourceRowCount, 1);
	const before = stagingSnapshot(fixture.dbPath);

	assert.throws(
		() => stageV10ContentBlobMigrationBatch({
			dbPath: fixture.dbPath,
			batchSize: 2,
			clock: () => V10_CONTENT_MIGRATION_NOW,
			failpoint: (point) => {
				if (point === "after_source_staged") throw new Error("private interrupted source");
			},
		}),
		(error: unknown) => error instanceof StorageFailure
			&& !error.message.includes("private interrupted source"),
	);
	assert.deepEqual(stagingSnapshot(fixture.dbPath), before);

	const retried = stage(fixture.dbPath, 2);
	assert.equal(retried.selectedSourceRowCount, 2);
	assert.equal(retried.totalStagedSourceRowCount, 3);
	const complete = drain(fixture.dbPath, 2);
	assert.equal(complete.complete, true);
	assert.equal(sourceMapUniqueness(fixture.dbPath), true);
});

test("serializes batches from independent processes", async (t) => {
	const fixture = await databaseFixture(t, "processes");
	seedV10ContentBlobMigrationFixture(fixture.dbPath);
	const [left, right] = await Promise.all([
		runStageProcess(fixture.dbPath, 2),
		runStageProcess(fixture.dbPath, 2),
	]);
	assert.equal(left.selectedSourceRowCount, 2);
	assert.equal(right.selectedSourceRowCount, 2);
	assert.deepEqual([left.batchId, right.batchId].sort(), [1, 2]);
	assert.equal(left.schemaVersion, 10);
	assert.equal(right.schemaVersion, 10);
	assert.equal(sourceMapCount(fixture.dbPath), 4);
	assert.equal(sourceMapUniqueness(fixture.dbPath), true);
});

test("stages newly appended v10 tails after an earlier complete pass", async (t) => {
	const fixture = await databaseFixture(t, "tail");
	seedV10ContentBlobMigrationFixture(fixture.dbPath);
	assert.equal(drain(fixture.dbPath, 3).complete, true);
	const before = sourceMapCount(fixture.dbPath);
	appendV10ContentBlobMigrationTail(fixture.dbPath);

	const firstTail = stage(fixture.dbPath, 5);
	assert.equal(firstTail.selectedSourceRowCount, 2);
	assert.equal(firstTail.selectedTranscriptEventCount, 1);
	assert.equal(firstTail.selectedModelInputBlobCount, 1);
	assert.equal(firstTail.complete, true);
	assert.equal(firstTail.totalStagedSourceRowCount, before + 2);
	assert.equal(schemaVersion(fixture.dbPath), 10);
	assert.equal(sourceMapUniqueness(fixture.dbPath), true);
});

test("fails closed on changed event and model-input sources and resumes after restoration", async (t) => {
	const fixture = await databaseFixture(t, "source-conflict");
	seedV10ContentBlobMigrationFixture(fixture.dbPath);
	drain(fixture.dbPath, 3);
	const database = new Database(fixture.dbPath);
	const event = database.prepare(`
		SELECT events.sequence_no, events.payload_json
		FROM content_blob_migration_event_source_map AS mapped
		JOIN transcript_events AS events ON events.sequence_no = mapped.sequence_no
		ORDER BY events.sequence_no LIMIT 1
	`).get() as { readonly sequence_no: number; readonly payload_json: string };
	database.exec("DROP TRIGGER transcript_events_no_update");
	database.prepare(`
		UPDATE transcript_events SET payload_json = json_set(payload_json, '$.payload.text', 'changed')
		WHERE sequence_no = ?
	`).run(event.sequence_no);
	database.close();

	assertSourceConflict(fixture.dbPath, "transcript_event");
	const restoreEvent = new Database(fixture.dbPath);
	restoreEvent.prepare("UPDATE transcript_events SET payload_json = ? WHERE sequence_no = ?")
		.run(event.payload_json, event.sequence_no);
	restoreEvent.exec(`
		CREATE TRIGGER transcript_events_no_update
		BEFORE UPDATE ON transcript_events BEGIN
			SELECT RAISE(ABORT, 'transcript_events are append-only');
		END
	`);
	restoreEvent.close();
	assert.equal(stage(fixture.dbPath, 2).complete, true);

	const modelDatabase = new Database(fixture.dbPath);
	const model = modelDatabase.prepare(`
		SELECT owner.blob_id, owner.payload_json
		FROM content_blob_migration_model_input_source_map AS mapped
		JOIN model_input_blobs AS owner ON owner.blob_id = mapped.blob_id
		ORDER BY owner.blob_id LIMIT 1
	`).get() as { readonly blob_id: string; readonly payload_json: string };
	modelDatabase.exec("DROP TRIGGER model_input_blobs_no_update");
	modelDatabase.prepare("UPDATE model_input_blobs SET payload_json = ? WHERE blob_id = ?")
		.run('{"changed":true}', model.blob_id);
	modelDatabase.close();

	assertSourceConflict(fixture.dbPath, "model_input_blob");
	const restoreModel = new Database(fixture.dbPath);
	restoreModel.prepare("UPDATE model_input_blobs SET payload_json = ? WHERE blob_id = ?")
		.run(model.payload_json, model.blob_id);
	restoreModel.exec(`
		CREATE TRIGGER model_input_blobs_no_update
		BEFORE UPDATE ON model_input_blobs BEGIN
			SELECT RAISE(ABORT, 'model_input_blobs are immutable');
		END
	`);
	restoreModel.close();
	assert.equal(stage(fixture.dbPath, 2).complete, true);
	assert.equal(conflictCount(fixture.dbPath), 0);
});

test("explicit cleanup discards staging only and is idempotent", async (t) => {
	const fixture = await databaseFixture(t, "cleanup");
	seedV10ContentBlobMigrationFixture(fixture.dbPath);
	stage(fixture.dbPath, 2);
	const before = authoritativeSnapshot(fixture.dbPath);

	const discarded = discardV10ContentBlobMigrationStaging({ dbPath: fixture.dbPath });
	assert.equal(discarded.discarded, true);
	assert.equal(discarded.discardedBatchCount, 1);
	assert.equal(discarded.discardedSourceRowCount, 2);
	assert.ok(discarded.discardedReferenceCount >= 2);
	assert.ok(discarded.discardedContentBlobCount >= 1);
	assert.equal(stagingObjectCount(fixture.dbPath), 0);
	assert.deepEqual(authoritativeSnapshot(fixture.dbPath), before);

	const repeated = discardV10ContentBlobMigrationStaging({ dbPath: fixture.dbPath });
	assert.deepEqual(repeated, {
		schemaVersion: 10,
		stagingSchemaVersion: 1,
		discarded: false,
		discardedBatchCount: 0,
		discardedSourceRowCount: 0,
		discardedReferenceCount: 0,
		discardedContentBlobCount: 0,
	});
	assert.deepEqual(authoritativeSnapshot(fixture.dbPath), before);
});

function assertSourceConflict(dbPath: string, sourceKind: string): void {
	assert.throws(
		() => stage(dbPath, 2),
		(error: unknown) => error instanceof StorageFailure
			&& error.message.endsWith("content-blob migration source changed after staging")
			&& error.diagnostics.source_kind === sourceKind
			&& !JSON.stringify(error.diagnostics).includes("migration-session"),
	);
}

function stage(dbPath: string, batchSize: number): V10ContentBlobMigrationStagingBatchResult {
	return stageV10ContentBlobMigrationBatch({
		dbPath,
		batchSize,
		clock: () => V10_CONTENT_MIGRATION_NOW,
	});
}

function drain(dbPath: string, batchSize: number): V10ContentBlobMigrationStagingBatchResult {
	for (let index = 0; index < 100; index += 1) {
		const result = stage(dbPath, batchSize);
		if (result.complete) return result;
	}
	throw new Error("content-blob staging fixture did not converge");
}

async function runStageProcess(
	dbPath: string,
	batchSize: number,
): Promise<V10ContentBlobMigrationStagingBatchResult> {
	const fixturePath = join(
		import.meta.dirname,
		"fixtures",
		"v10-content-blob-stage-process.mjs",
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
			resolve(JSON.parse(stdout) as V10ContentBlobMigrationStagingBatchResult);
		});
	});
}

function stagingSnapshot(dbPath: string): readonly unknown[] {
	const database = new Database(dbPath, { readonly: true });
	try {
		return Object.freeze([
			database.prepare("SELECT * FROM content_blob_migration_batches ORDER BY batch_id").all(),
			database.prepare(`
				SELECT * FROM content_blob_migration_content ORDER BY blob_id
			`).all(),
			database.prepare(`
				SELECT * FROM content_blob_migration_event_source_map ORDER BY sequence_no
			`).all(),
			database.prepare(`
				SELECT * FROM content_blob_migration_event_refs ORDER BY sequence_no, json_pointer
			`).all(),
			database.prepare(`
				SELECT * FROM content_blob_migration_model_input_source_map ORDER BY blob_id
			`).all(),
		]);
	} finally {
		database.close();
	}
}

function authoritativeSnapshot(dbPath: string): readonly unknown[] {
	const database = new Database(dbPath, { readonly: true });
	try {
		return Object.freeze([
			database.prepare("SELECT version FROM schema_version").pluck().get(),
			database.prepare(`
				SELECT sequence_no, payload_json FROM transcript_events ORDER BY sequence_no
			`).all(),
			database.prepare(`
				SELECT blob_id, payload_json FROM model_input_blobs ORDER BY blob_id
			`).all(),
		]);
	} finally {
		database.close();
	}
}

function sourceMapCount(dbPath: string): number {
	const database = new Database(dbPath, { readonly: true });
	try {
		return scalar(database, `
			SELECT (SELECT COUNT(*) FROM content_blob_migration_event_source_map)
			     + (SELECT COUNT(*) FROM content_blob_migration_model_input_source_map)
		`);
	} finally {
		database.close();
	}
}

function sourceMapUniqueness(dbPath: string): boolean {
	const database = new Database(dbPath, { readonly: true });
	try {
		const eventTotal = scalar(database, "SELECT COUNT(*) FROM content_blob_migration_event_source_map");
		const eventUnique = scalar(database, `
			SELECT COUNT(DISTINCT sequence_no) FROM content_blob_migration_event_source_map
		`);
		const modelTotal = scalar(
			database,
			"SELECT COUNT(*) FROM content_blob_migration_model_input_source_map",
		);
		const modelUnique = scalar(database, `
			SELECT COUNT(DISTINCT blob_id) FROM content_blob_migration_model_input_source_map
		`);
		return eventTotal === eventUnique && modelTotal === modelUnique;
	} finally {
		database.close();
	}
}

function conflictCount(dbPath: string): number {
	const database = new Database(dbPath, { readonly: true });
	try {
		return scalar(database, "SELECT COUNT(*) FROM content_blob_migration_source_conflicts");
	} finally {
		database.close();
	}
}

function schemaVersion(dbPath: string): number {
	const database = new Database(dbPath, { readonly: true });
	try {
		return Number(database.prepare("SELECT version FROM schema_version").pluck().get());
	} finally {
		database.close();
	}
}

function stagingObjectCount(dbPath: string): number {
	const database = new Database(dbPath, { readonly: true });
	try {
		return scalar(database, `
			SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'content_blob_migration_%'
		`);
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
	const root = await mkdtemp(join(tmpdir(), `mycli-v10-content-staging-${name}-`));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return { root, dbPath: join(root, "sessions.db") };
}
