import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	applyV10ContentBlobMigrationCutover,
	stageV10ContentBlobMigrationBatch,
	StorageFailure,
	V10_CONTENT_BLOB_CUTOVER_MINIMUM_FREE_BYTES,
	V10_CONTENT_BLOB_CUTOVER_STAGES,
} from "../../../src/index.ts";
import {
	appendV10ContentBlobMigrationTail,
	seedV10ContentBlobMigrationFixture,
	V10_CONTENT_MIGRATION_NOW,
} from "../../support/v10-content-blob-migration-fixtures.ts";

test("rolls back every cutover failpoint and retries from the complete v10 staging shape", async (t) => {
	for (const stage of V10_CONTENT_BLOB_CUTOVER_STAGES) {
		await t.test(stage, async (t) => {
			const fixture = await databaseFixture(t, `failpoint-${stage}`);
			seedV10ContentBlobMigrationFixture(fixture.dbPath);
			drainStaging(fixture.dbPath, 2);
			const before = rollbackShape(fixture.dbPath);
			assert.throws(
				() => applyV10ContentBlobMigrationCutover({
					dbPath: fixture.dbPath,
					clock: () => V10_CONTENT_MIGRATION_NOW,
					failpoint: (candidate) => {
						if (candidate === stage) throw new Error(`private failpoint ${stage}`);
					},
				}),
				(error: unknown) => error instanceof StorageFailure
					&& !error.message.includes("private failpoint"),
			);
			assert.deepEqual(rollbackShape(fixture.dbPath), before);
			assert.equal(schemaVersion(fixture.dbPath), 10);
			assert.equal(finalObjectCount(fixture.dbPath), 0);

			const retried = applyV10ContentBlobMigrationCutover({
				dbPath: fixture.dbPath,
				clock: () => V10_CONTENT_MIGRATION_NOW,
			});
			assert.equal(retried.schemaVersion, 11);
			assert.equal(schemaVersion(fixture.dbPath), 11);
		});
	}
});

test("refuses active recovery state, busy writers, and insufficient free space", async (t) => {
	const active = await databaseFixture(t, "active");
	seedV10ContentBlobMigrationFixture(active.dbPath);
	drainStaging(active.dbPath, 2);
	const activeDatabase = new Database(active.dbPath);
	activeDatabase.prepare(`
		INSERT INTO runtime_turns (
			session_id, client_turn_id, turn_id, request_fingerprint, status,
			error_code, result_json, started_at, completed_at, owner_id, owner_pid
		) VALUES (?, ?, ?, ?, 'in_progress', NULL, NULL, ?, NULL, NULL, NULL)
	`).run(
		"migration-session",
		"active-client",
		"active-turn",
		`sha256:${"a".repeat(64)}`,
		V10_CONTENT_MIGRATION_NOW,
	);
	activeDatabase.close();
	assert.throws(
		() => cutover(active.dbPath),
		(error: unknown) => error instanceof StorageFailure
			&& error.diagnostics.active_runtime_turn_count === 1
			&& !JSON.stringify(error.diagnostics).includes("migration-session"),
	);
	assert.equal(schemaVersion(active.dbPath), 10);

	const busy = await databaseFixture(t, "busy");
	seedV10ContentBlobMigrationFixture(busy.dbPath);
	drainStaging(busy.dbPath, 2);
	const lock = new Database(busy.dbPath);
	lock.exec("BEGIN IMMEDIATE");
	try {
		assert.throws(
			() => applyV10ContentBlobMigrationCutover({
				dbPath: busy.dbPath,
				busyTimeoutMs: 0,
			}),
			(error: unknown) => error instanceof StorageFailure
				&& error.message.endsWith("database is busy"),
		);
	} finally {
		lock.exec("ROLLBACK");
		lock.close();
	}
	assert.equal(schemaVersion(busy.dbPath), 10);

	const disk = await databaseFixture(t, "disk");
	seedV10ContentBlobMigrationFixture(disk.dbPath);
	drainStaging(disk.dbPath, 2);
	const before = rollbackShape(disk.dbPath);
	assert.throws(
		() => applyV10ContentBlobMigrationCutover({
			dbPath: disk.dbPath,
			freeSpaceProbe: () => V10_CONTENT_BLOB_CUTOVER_MINIMUM_FREE_BYTES - 1,
		}),
		(error: unknown) => error instanceof StorageFailure
			&& error.diagnostics.required_free_bytes
				=== V10_CONTENT_BLOB_CUTOVER_MINIMUM_FREE_BYTES
			&& error.diagnostics.available_free_bytes
				=== V10_CONTENT_BLOB_CUTOVER_MINIMUM_FREE_BYTES - 1,
	);
	assert.deepEqual(rollbackShape(disk.dbPath), before);
});

test("rejects oversized final tails without committing their partial reconciliation", async (t) => {
	const fixture = await databaseFixture(t, "tail-bound");
	seedV10ContentBlobMigrationFixture(fixture.dbPath);
	drainStaging(fixture.dbPath, 2);
	appendV10ContentBlobMigrationTail(fixture.dbPath);
	const before = rollbackShape(fixture.dbPath);
	assert.throws(
		() => applyV10ContentBlobMigrationCutover({
			dbPath: fixture.dbPath,
			tailBatchSize: 1,
			clock: () => V10_CONTENT_MIGRATION_NOW,
		}),
		(error: unknown) => error instanceof StorageFailure
			&& error.diagnostics.remaining_source_rows === 1,
	);
	assert.deepEqual(rollbackShape(fixture.dbPath), before);
	assert.equal(schemaVersion(fixture.dbPath), 10);
});

test("rejects corrupt staged content and references while retaining schema v10", async (t) => {
	const content = await databaseFixture(t, "invalid-content");
	seedV10ContentBlobMigrationFixture(content.dbPath);
	drainStaging(content.dbPath, 2);
	const contentDatabase = new Database(content.dbPath);
	contentDatabase.exec("DROP TRIGGER content_blob_migration_content_no_update");
	contentDatabase.exec(`
		UPDATE content_blob_migration_content
		SET payload_blob = zeroblob(stored_bytes)
		WHERE blob_id = (SELECT blob_id FROM content_blob_migration_content ORDER BY blob_id LIMIT 1)
	`);
	contentDatabase.close();
	assert.throws(
		() => cutover(content.dbPath),
		(error: unknown) => error instanceof StorageFailure
			&& !JSON.stringify(error.diagnostics).includes("sha256:"),
	);
	assert.equal(schemaVersion(content.dbPath), 10);
	assert.equal(finalObjectCount(content.dbPath), 0);

	const reference = await databaseFixture(t, "invalid-reference");
	seedV10ContentBlobMigrationFixture(reference.dbPath);
	drainStaging(reference.dbPath, 2);
	const referenceDatabase = new Database(reference.dbPath);
	referenceDatabase.prepare(`
		UPDATE content_blob_migration_event_refs SET json_pointer = '/payload/missing'
		WHERE rowid = (SELECT rowid FROM content_blob_migration_event_refs ORDER BY rowid LIMIT 1)
	`).run();
	referenceDatabase.close();
	assert.throws(
		() => cutover(reference.dbPath),
		(error: unknown) => error instanceof StorageFailure
			&& !JSON.stringify(error.diagnostics).includes("/payload/missing"),
	);
	assert.equal(schemaVersion(reference.dbPath), 10);
	assert.equal(finalObjectCount(reference.dbPath), 0);
});

test("allows exactly one of two cutover processes to install marker 11", async (t) => {
	const fixture = await databaseFixture(t, "processes");
	seedV10ContentBlobMigrationFixture(fixture.dbPath);
	drainStaging(fixture.dbPath, 2);
	const results = await Promise.all([
		runCutoverProcess(fixture.dbPath),
		runCutoverProcess(fixture.dbPath),
	]);
	assert.equal(results.filter((result) => result.ok).length, 1);
	const rejected = results.find((result) => !result.ok);
	assert.ok(rejected);
	assert.equal(rejected.diagnostics.actual_version, 11);
	assert.equal(schemaVersion(fixture.dbPath), 11);
	assert.equal(stagingObjectCount(fixture.dbPath), 0);
});

function cutover(dbPath: string): void {
	applyV10ContentBlobMigrationCutover({
		dbPath,
		clock: () => V10_CONTENT_MIGRATION_NOW,
	});
}

function drainStaging(dbPath: string, batchSize: number): void {
	for (let index = 0; index < 100; index += 1) {
		const result = stageV10ContentBlobMigrationBatch({
			dbPath,
			batchSize,
			clock: () => V10_CONTENT_MIGRATION_NOW,
		});
		if (result.complete) return;
	}
	throw new Error("content-blob staging fixture did not converge");
}

interface CutoverProcessResult {
	readonly ok: boolean;
	readonly diagnostics: Readonly<Record<string, unknown>>;
}

async function runCutoverProcess(dbPath: string): Promise<CutoverProcessResult> {
	const fixturePath = join(
		import.meta.dirname,
		"..",
		"..",
		"fixtures",
		"v10-content-blob-cutover-process.mjs",
	);
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", fixturePath, dbPath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code !== 0) {
				reject(new Error(`cutover process failed with code ${String(code)}: ${stderr.slice(0, 200)}`));
				return;
			}
			const parsed = JSON.parse(stdout) as Readonly<Record<string, unknown>>;
			resolve({
				ok: parsed.ok === true,
				diagnostics: isRecord(parsed.diagnostics) ? parsed.diagnostics : Object.freeze({}),
			});
		});
	});
}

function rollbackShape(dbPath: string): readonly unknown[] {
	const database = new Database(dbPath, { readonly: true });
	try {
		return Object.freeze([
			database.prepare("SELECT version FROM schema_version").pluck().get(),
			database.prepare(`
				SELECT name, type, sql FROM sqlite_master
				WHERE name LIKE 'content_blob_migration_%'
				ORDER BY type, name
			`).all(),
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

function schemaVersion(dbPath: string): number {
	const database = new Database(dbPath, { readonly: true });
	try {
		return Number(database.prepare("SELECT version FROM schema_version").pluck().get());
	} finally {
		database.close();
	}
}

function finalObjectCount(dbPath: string): number {
	const database = new Database(dbPath, { readonly: true });
	try {
		return scalar(database, `
			SELECT COUNT(*) FROM sqlite_master
			WHERE name IN ('session_content_blobs', 'transcript_event_blob_refs', 'model_input_blob_refs')
		`);
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function databaseFixture(t: test.TestContext, name: string): Promise<{
	readonly root: string;
	readonly dbPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), `mycli-v10-content-cutover-${name}-`));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return { root, dbPath: join(root, "sessions.db") };
}
