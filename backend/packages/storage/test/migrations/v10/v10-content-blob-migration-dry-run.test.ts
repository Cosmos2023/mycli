import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	analyzeV10ContentBlobMigration,
	createV10SessionDatabase,
	StorageFailure,
} from "../../../src/index.ts";

const NOW = "2026-08-14T00:00:00.000Z";

test("reports bounded v10-to-v11 coverage, FTS work, writers, batches, and headroom read-only", async (t) => {
	const fixture = await databaseFixture(t);
	createV10SessionDatabase({ dbPath: fixture.dbPath, clock: () => NOW });
	const database = new Database(fixture.dbPath);
	database.prepare(`
		INSERT INTO sessions (
			session_id, workspace_root, thread_id, created_at, updated_at, last_active_at, status
		) VALUES (?, ?, ?, ?, ?, ?, 'active')
	`).run("private-session", fixture.root, "private-session", NOW, NOW, NOW);
	const payload = JSON.stringify({
		schemaVersion: 1,
		payload: { text: "private migration content\n".repeat(200) },
	});
	for (let index = 0; index < 3; index += 1) {
		database.prepare(`
			INSERT INTO transcript_events (
				session_id, event_id, turn_id, event_type, provider_index,
				model_visible, payload_json, created_at
			) VALUES (?, ?, ?, 'assistant_output', ?, 1, ?, ?)
		`).run("private-session", `private-event-${index}`, "private-turn", index, payload, NOW);
	}
	database.prepare(`
		INSERT INTO model_input_blobs (blob_id, payload_json, created_at) VALUES (?, ?, ?)
	`).run("private-model-input", JSON.stringify({ content: "model input".repeat(500) }), NOW);
	database.prepare(`
		INSERT INTO runtime_turns (
			session_id, client_turn_id, turn_id, request_fingerprint, status,
			error_code, result_json, started_at, completed_at, owner_id, owner_pid
		) VALUES (?, ?, ?, ?, 'in_progress', NULL, NULL, ?, NULL, NULL, NULL)
	`).run("private-session", "private-client", "private-turn", `sha256:${"a".repeat(64)}`, NOW);
	database.close();
	const before = await stat(fixture.dbPath);

	const report = analyzeV10ContentBlobMigration({ dbPath: fixture.dbPath, batchSize: 2 });
	const after = await stat(fixture.dbPath);
	assert.equal(report.schemaVersion, 10);
	assert.equal(report.targetSchemaVersion, 11);
	assert.equal(report.dryRun, true);
	assert.deepEqual(report.batchPlan, {
		batchSize: 2,
		transcriptEventRowCount: 3,
		modelInputBlobRowCount: 1,
		sourceRowCount: 4,
		plannedBatchCount: 2,
		stagingPresent: false,
		completedBatchCount: 0,
		stagedSourceRowCount: 0,
		unresolvedSourceConflictCount: 0,
		remainingSourceRowCount: 4,
	});
	assert.equal(report.ftsRebuild.eligibleEventCount, 3);
	assert.ok(report.ftsRebuild.canonicalPayloadBytes > 0);
	assert.deepEqual(report.activeWriters, {
		activeRuntimeTurnCount: 1,
		activeRecoveryStateCount: 0,
		activeSessionCount: 1,
		blocksCutover: true,
	});
	assert.ok(report.analysis.uniqueBlobCount >= 2);
	assert.ok(report.temporarySpace.estimatedTemporaryPeakBytes > 0);
	assert.equal(after.size, before.size);
	assert.equal(after.mtimeMs, before.mtimeMs);
	const rendered = JSON.stringify(report);
	for (const privateValue of [
		"private-session",
		"private-event",
		"private migration content",
		"private-model-input",
		fixture.root,
	]) assert.equal(rendered.includes(privateValue), false);
});

test("rejects invalid dry-run bounds and non-v10 storage", async (t) => {
	const fixture = await databaseFixture(t);
	createV10SessionDatabase({ dbPath: fixture.dbPath });
	assert.throws(
		() => analyzeV10ContentBlobMigration({ dbPath: fixture.dbPath, batchSize: 0 }),
		/batchSize must be between 1 and 5000/u,
	);
	const database = new Database(fixture.dbPath);
	database.prepare("UPDATE schema_version SET version = 11").run();
	database.close();
	assert.throws(
		() => analyzeV10ContentBlobMigration({ dbPath: fixture.dbPath }),
		(error: unknown) => error instanceof StorageFailure
			&& error.diagnostics.expected_version === 10
			&& error.diagnostics.actual_version === 11
			&& !error.message.includes(fixture.dbPath),
	);
});

async function databaseFixture(t: test.TestContext): Promise<{
	readonly root: string;
	readonly dbPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-v10-content-migration-dry-run-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return { root, dbPath: join(root, "sessions.db") };
}
