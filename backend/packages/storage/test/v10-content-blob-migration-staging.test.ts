import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	analyzeV10ContentBlobMigration,
	stageV10ContentBlobMigrationBatch,
	type V10ContentBlobMigrationStagingBatchResult,
} from "../src/index.ts";
import {
	seedV10ContentBlobMigrationFixture,
	V10_CONTENT_MIGRATION_MODEL_JSON,
	V10_CONTENT_MIGRATION_NOW,
} from "./support/v10-content-blob-migration-fixtures.ts";

test("stages deterministic bounded source maps while schema v10 remains authoritative", async (t) => {
	const fixture = await databaseFixture(t, "bounded");
	seedV10ContentBlobMigrationFixture(fixture.dbPath);
	const before = authoritativeSnapshot(fixture.dbPath);

	const byteBounded = stage(fixture.dbPath, 5, 1);
	assert.equal(byteBounded.selectedSourceRowCount, 1);
	assert.equal(byteBounded.selectedTranscriptEventCount, 1);
	assert.equal(byteBounded.selectedModelInputBlobCount, 0);
	const batches = [byteBounded, ...drain(fixture.dbPath, 2)];
	assert.ok(batches.every((batch) => batch.selectedSourceRowCount <= 2
		|| batch === byteBounded));
	const completed = batches.at(-1)!;
	assert.equal(completed.complete, true);
	assert.equal(completed.remainingSourceRowCount, 0);
	assert.equal(completed.totalStagedTranscriptEventCount, 4);
	assert.equal(completed.totalStagedModelInputBlobCount, 2);
	assert.ok(completed.totalStagedReferenceCount > completed.totalStagedContentBlobCount);
	assert.ok(batches.every((batch) => batch.newStoredBytes <= batch.newRawBytes));

	const database = new Database(fixture.dbPath, { readonly: true });
	try {
		assert.equal(database.prepare("SELECT version FROM schema_version").pluck().get(), 10);
		assert.equal(objectExists(database, "session_content_blobs"), false);
		const sharedContentId = String(database.prepare(`
			SELECT content_blob_id FROM content_blob_migration_model_input_source_map
			WHERE blob_id = (
				SELECT blob_id FROM model_input_blobs WHERE payload_json = ?
			)
		`).pluck().get(V10_CONTENT_MIGRATION_MODEL_JSON));
		assert.ok(database.prepare(`
			SELECT 1 FROM content_blob_migration_event_refs WHERE blob_id = ? LIMIT 1
		`).get(sharedContentId));
		const stagedPayload = String(database.prepare(`
			SELECT staged_payload_json FROM content_blob_migration_event_source_map
			ORDER BY sequence_no LIMIT 1
		`).pluck().get());
		assert.equal(stagedPayload.includes(V10_CONTENT_MIGRATION_MODEL_JSON), false);
		assert.equal(stagedPayload.includes('"text":null'), true);
		assert.equal(scalar(database, `
			SELECT COUNT(*) FROM content_blob_migration_content
			WHERE codec = 'deflate-raw-v1'
		`) > 0, true);
	} finally {
		database.close();
	}
	assert.deepEqual(authoritativeSnapshot(fixture.dbPath), before);

	const stable = stagingSnapshot(fixture.dbPath);
	const progress = analyzeV10ContentBlobMigration({ dbPath: fixture.dbPath, batchSize: 2 });
	assert.equal(progress.batchPlan.stagingPresent, true);
	assert.equal(progress.batchPlan.stagedSourceRowCount, 6);
	assert.equal(progress.batchPlan.remainingSourceRowCount, 0);
	assert.equal(progress.batchPlan.completedBatchCount, batches.length);
	for (let index = 0; index < 2; index += 1) {
		const idempotent = stage(fixture.dbPath, 2);
		assert.equal(idempotent.batchId, null);
		assert.equal(idempotent.selectedSourceRowCount, 0);
		assert.deepEqual(stagingSnapshot(fixture.dbPath), stable);
	}
});

test("produces identical staging rows for independent equivalent v10 databases", async (t) => {
	const left = await databaseFixture(t, "deterministic-left");
	const right = await databaseFixture(t, "deterministic-right");
	seedV10ContentBlobMigrationFixture(left.dbPath);
	seedV10ContentBlobMigrationFixture(right.dbPath);
	drain(left.dbPath, 2);
	drain(right.dbPath, 2);
	assert.deepEqual(stagingSnapshot(left.dbPath), stagingSnapshot(right.dbPath));
});

test("rejects invalid bounds and non-v10 storage without installing staging tables", async (t) => {
	const fixture = await databaseFixture(t, "rejection");
	seedV10ContentBlobMigrationFixture(fixture.dbPath);
	for (const batchSize of [0, -1, 5_001, 1.5]) {
		assert.throws(
			() => stageV10ContentBlobMigrationBatch({ dbPath: fixture.dbPath, batchSize }),
			/batchSize must be between 1 and 5000/u,
		);
	}
	assert.throws(
		() => stageV10ContentBlobMigrationBatch({
			dbPath: fixture.dbPath,
			maxBatchRawBytes: 512 * 1024 * 1024 + 1,
		}),
		/maxBatchRawBytes must be between 1 and 536870912/u,
	);
	const database = new Database(fixture.dbPath);
	database.prepare("UPDATE schema_version SET version = 11").run();
	database.close();
	assert.throws(
		() => stage(fixture.dbPath, 1),
		(error: unknown) => isStorageVersionError(error),
	);
	const read = new Database(fixture.dbPath, { readonly: true });
	try {
		assert.equal(scalar(read, `
			SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'content_blob_migration_%'
		`), 0);
	} finally {
		read.close();
	}
});

function stage(
	dbPath: string,
	batchSize: number,
	maxBatchRawBytes = 64 * 1024 * 1024,
): V10ContentBlobMigrationStagingBatchResult {
	return stageV10ContentBlobMigrationBatch({
		dbPath,
		batchSize,
		maxBatchRawBytes,
		clock: () => V10_CONTENT_MIGRATION_NOW,
	});
}

function drain(
	dbPath: string,
	batchSize: number,
): readonly V10ContentBlobMigrationStagingBatchResult[] {
	const batches: V10ContentBlobMigrationStagingBatchResult[] = [];
	for (let index = 0; index < 100; index += 1) {
		const result = stage(dbPath, batchSize);
		if (result.batchId !== null) batches.push(result);
		if (result.complete) return Object.freeze(batches);
	}
	throw new Error("content-blob staging fixture did not converge");
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

function objectExists(database: Database.Database, name: string): boolean {
	return database.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name) !== undefined;
}

function scalar(database: Database.Database, sql: string): number {
	return Number(database.prepare(sql).pluck().get());
}

function isStorageVersionError(error: unknown): boolean {
	return typeof error === "object" && error !== null
		&& "diagnostics" in error
		&& (error as { readonly diagnostics: Readonly<Record<string, unknown>> }).diagnostics
			.expected_version === 10;
}

async function databaseFixture(t: test.TestContext, name: string): Promise<{
	readonly root: string;
	readonly dbPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), `mycli-v10-content-staging-${name}-`));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return { root, dbPath: join(root, "sessions.db") };
}
