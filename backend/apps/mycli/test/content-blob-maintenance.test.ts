import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
	createV10SessionDatabase,
	createV12SessionDatabase,
	SQLiteSessionStore,
	SQLiteTranscriptEventRepository,
} from "@mycli/storage";
import {
	contentBlobMigrationReport,
	cutoverContentBlobMigration,
	prepareContentBlobMigration,
} from "../src/node-runtime/content-blob-maintenance.ts";

const NOW = "2026-08-15T00:00:00.000Z";

test("reports, stages, and cuts over content blobs through bounded results", async (t) => {
	const fixture = await maintenanceFixture(t, "cutover");
	createV10SessionDatabase({ dbPath: fixture.dbPath });
	const database = new DatabaseSync(fixture.dbPath);
	insertSession(database, fixture.root, "private-content-session");
	database.close();
	const store = new SQLiteTranscriptEventRepository({ dbPath: fixture.dbPath, clock: () => NOW });
	store.appendEvent({
		schemaVersion: 1,
		sessionId: "private-content-session",
		eventId: "private-content-event",
		turnId: "private-content-turn",
		eventType: "tool_result",
		modelVisible: true,
		createdAt: NOW,
		payload: {
			result: {
				callId: "private-call",
				toolName: "Read",
				output: "private repeated tool output\n".repeat(1_000),
				success: true,
			},
			summary: "bounded private summary",
		},
	});
	store.close();
	const beforeReport = await stat(fixture.dbPath);

	const report = contentBlobMigrationReport(fixture.dbPath);

	assert.equal(report.content_blob_migration_status, "not_started");
	assert.equal(report.content_blob_migration_dry_run, true);
	assert.equal(report.content_blob_migration_schema_version, 10);
	assert.equal(report.content_blob_migration_target_schema_version, 11);
	assert.ok(Number(report.content_blob_unique_raw_bytes) > 0);
	assert.ok(Number(report.content_blob_estimated_stored_bytes) > 0);
	assert.equal(report.physical_bytes_reduced_by_content_blobs, 0);
	assert.equal(report.explicit_vacuum_required, true);
	assert.equal((await stat(fixture.dbPath)).mtimeMs, beforeReport.mtimeMs);

	const staged = prepareContentBlobMigration(fixture.dbPath);
	assert.equal(staged.cutoverReady, false);
	assert.equal(staged.result.phase, "staging");
	assert.equal(staged.result.status, "ready_for_cutover");
	assert.equal(staged.result.cutover_ready, true);
	assert.equal(schemaVersion(fixture.dbPath), 10);

	const ready = prepareContentBlobMigration(fixture.dbPath);
	assert.equal(ready.cutoverReady, true);
	assert.equal(ready.result.status, "ready_for_cutover");
	const cutover = cutoverContentBlobMigration(fixture.dbPath, ready);
	assert.equal(cutover.status, "blob_backed");
	assert.equal(cutover.schema_version, 11);
	assert.equal(cutover.parity_validated, true);
	assert.equal(cutover.backend_restart_required, true);
	assert.equal(cutover.physical_bytes_reduced_by_content_blobs, 0);
	assert.equal(cutover.explicit_vacuum_required, true);
	assert.equal(schemaVersion(fixture.dbPath), 11);
	assert.equal(hasObject(fixture.dbPath, "session_content_blobs"), true);
	assert.equal(hasObject(fixture.dbPath, "content_blob_migration_batches"), false);
	assert.doesNotMatch(
		JSON.stringify({ report, staged: staged.result, cutover }),
		/private repeated tool|private-content|private-call|sha256:/u,
	);

	const migratedBefore = await stat(fixture.dbPath);
	const migrated = contentBlobMigrationReport(fixture.dbPath);
	assert.equal(migrated.content_blob_migration_status, "blob_backed");
	assert.equal(migrated.content_blob_migration_schema_version, 11);
	assert.equal((await stat(fixture.dbPath)).mtimeMs, migratedBefore.mtimeMs);
	assert.equal(prepareContentBlobMigration(fixture.dbPath).result.status, "already_blob_backed");
});

test("requires transcript normalization before content blobs on schema v9", async (t) => {
	const fixture = await maintenanceFixture(t, "v9");
	new SQLiteSessionStore({ dbPath: fixture.dbPath }).close();
	const before = await stat(fixture.dbPath);

	const report = contentBlobMigrationReport(fixture.dbPath);
	const preparation = prepareContentBlobMigration(fixture.dbPath);

	assert.equal(report.content_blob_migration_status, "requires_transcript_normalization");
	assert.equal(report.content_blob_migration_schema_version, 9);
	assert.equal(preparation.cutoverReady, false);
	assert.equal(preparation.result.status, "requires_transcript_normalization");
	assert.equal(schemaVersion(fixture.dbPath), 9);
	assert.equal((await stat(fixture.dbPath)).mtimeMs, before.mtimeMs);
});

test("stages content blobs but blocks cutover while recovery state is active", async (t) => {
	const fixture = await maintenanceFixture(t, "active");
	createV10SessionDatabase({ dbPath: fixture.dbPath });
	const database = new DatabaseSync(fixture.dbPath);
	insertSession(database, fixture.root, "private-active-content-session");
	database.prepare(`
		INSERT INTO runtime_turns (
			session_id, client_turn_id, turn_id, request_fingerprint,
			status, started_at
		) VALUES (?, 'private-client', 'private-turn', ?, 'in_progress', ?)
	`).run("private-active-content-session", `sha256:${"5".repeat(64)}`, NOW);
	database.close();

	const result = prepareContentBlobMigration(fixture.dbPath);

	assert.equal(result.cutoverReady, false);
	assert.equal(result.result.status, "blocked_active_sessions");
	assert.equal(result.result.active_sessions, 1);
	assert.equal(result.result.cutover_ready, false);
	assert.equal(schemaVersion(fixture.dbPath), 10);
	assert.doesNotMatch(JSON.stringify(result.result), /private-active|private-client|private-turn/u);
});

test("reports fresh v12 storage as already blob-backed without writes", async (t) => {
	const fixture = await maintenanceFixture(t, "v12");
	createV12SessionDatabase({ dbPath: fixture.dbPath });
	const before = await stat(fixture.dbPath);

	const report = contentBlobMigrationReport(fixture.dbPath);
	const preparation = prepareContentBlobMigration(fixture.dbPath);

	assert.equal(report.content_blob_migration_status, "blob_backed");
	assert.equal(report.content_blob_migration_schema_version, 12);
	assert.equal(preparation.cutoverReady, false);
	assert.equal(preparation.result.status, "already_blob_backed");
	assert.equal(preparation.result.schema_version, 12);
	assert.equal((await stat(fixture.dbPath)).mtimeMs, before.mtimeMs);
});

function schemaVersion(dbPath: string): number {
	const database = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return Number(database.prepare("SELECT version FROM schema_version").get()?.version);
	} finally {
		database.close();
	}
}

function hasObject(dbPath: string, name: string): boolean {
	const database = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return database.prepare(`
			SELECT 1 AS present FROM sqlite_master WHERE name = ?
		`).get(name)?.present === 1;
	} finally {
		database.close();
	}
}

function insertSession(database: DatabaseSync, workspaceRoot: string, sessionId: string): void {
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at,
			updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, 'active')
	`).run(sessionId, workspaceRoot, sessionId, NOW, NOW, NOW);
}

async function maintenanceFixture(
	t: test.TestContext,
	name: string,
): Promise<Readonly<{ readonly root: string; readonly dbPath: string }>> {
	const root = await mkdtemp(join(tmpdir(), `mycli-content-blob-maintenance-${name}-`));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, ".mycli"));
	return Object.freeze({ root, dbPath: join(root, ".mycli", "sessions.db") });
}
