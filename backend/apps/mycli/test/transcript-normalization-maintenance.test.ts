import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createV12SessionDatabase, SQLiteSessionStore } from "@mycli/storage";
import {
	cutoverTranscriptNormalization,
	prepareTranscriptNormalization,
	transcriptNormalizationReport,
} from "../src/node-runtime/transcript-normalization-maintenance.ts";

const NOW = "2026-08-14T00:00:00.000Z";

test("reports, stages, and cuts over transcript normalization through bounded results", async (t) => {
	const fixture = await normalizationFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: () => NOW });
	store.reserveTurn({
		sessionId: "normalization-session",
		clientTurnId: "normalization-client-turn",
		clientUserMessageId: "normalization-user-message",
		turnId: "normalization-turn",
		requestFingerprint: `sha256:${"c".repeat(64)}`,
		workspaceRoot: fixture.root,
		threadId: "normalization-session",
		userText: "private normalization fixture input",
		startedAt: NOW,
	});
	store.completeTurn({
		sessionId: "normalization-session",
		clientTurnId: "normalization-client-turn",
		assistantText: "private normalization fixture output",
		usage: {},
		completedAt: NOW,
	});
	store.close();
	const beforeReport = await stat(fixture.dbPath);

	const report = transcriptNormalizationReport(fixture.dbPath);

	assert.equal(report.transcript_normalization_status, "not_started");
	assert.equal(report.transcript_normalization_dry_run, true);
	assert.ok(Number(report.transcript_source_rows) > 0);
	assert.ok(Number(report.transcript_estimated_temporary_peak_bytes) > 0);
	assert.equal(report.physical_bytes_reduced_by_normalization, 0);
	assert.equal(report.explicit_vacuum_required, true);
	assert.equal((await stat(fixture.dbPath)).mtimeMs, beforeReport.mtimeMs);

	const staged = prepareTranscriptNormalization(fixture.dbPath);
	assert.equal(staged.cutoverReady, false);
	assert.equal(staged.result.phase, "staging");
	assert.equal(staged.result.status, "ready_for_cutover");
	assert.equal(staged.result.cutover_ready, true);
	assert.ok(Number(staged.result.selected_source_rows) <= 500);
	assert.equal(schemaVersion(fixture.dbPath), 9);

	const ready = prepareTranscriptNormalization(fixture.dbPath);
	assert.equal(ready.cutoverReady, true);
	assert.equal(ready.result.status, "ready_for_cutover");
	const cutover = cutoverTranscriptNormalization(fixture.dbPath, ready);
	assert.equal(cutover.status, "normalized");
	assert.equal(cutover.schema_version, 10);
	assert.equal(cutover.backend_restart_required, true);
	assert.equal(cutover.physical_bytes_reduced_by_normalization, 0);
	assert.equal(cutover.explicit_vacuum_required, true);
	assert.equal(schemaVersion(fixture.dbPath), 10);
	assert.equal(hasObject(fixture.dbPath, "conversation_messages"), false);
	assert.doesNotMatch(
		JSON.stringify(cutover),
		/private normalization|normalization-session|normalization-turn/u,
	);

	const normalizedBefore = await stat(fixture.dbPath);
	const normalized = transcriptNormalizationReport(fixture.dbPath);
	assert.equal(normalized.transcript_normalization_status, "normalized");
	assert.equal(normalized.transcript_normalization_schema_version, 10);
	assert.equal((await stat(fixture.dbPath)).mtimeMs, normalizedBefore.mtimeMs);
	assert.equal(prepareTranscriptNormalization(fixture.dbPath).result.status, "already_normalized");
});

test("keeps active recovery sessions on v9 and reports a bounded blocked result", async (t) => {
	const fixture = await normalizationFixture(t);
	const store = new SQLiteSessionStore({ dbPath: fixture.dbPath, clock: () => NOW });
	store.reserveTurn({
		sessionId: "active-private-session",
		clientTurnId: "active-private-client-turn",
		clientUserMessageId: "active-private-user-message",
		turnId: "active-private-turn",
		requestFingerprint: `sha256:${"d".repeat(64)}`,
		workspaceRoot: fixture.root,
		threadId: "active-private-session",
		userText: "private active fixture input",
		startedAt: NOW,
	});
	store.close();

	const result = prepareTranscriptNormalization(fixture.dbPath);

	assert.equal(result.cutoverReady, false);
	assert.equal(result.result.status, "blocked_active_sessions");
	assert.equal(result.result.excluded_active_sessions, 1);
	assert.equal(result.result.cutover_ready, false);
	assert.equal(schemaVersion(fixture.dbPath), 9);
	assert.doesNotMatch(JSON.stringify(result.result), /active-private|private active/u);
});

test("reports fresh v12 storage as already normalized without writes", async (t) => {
	const fixture = await normalizationFixture(t);
	createV12SessionDatabase({ dbPath: fixture.dbPath });
	const before = await stat(fixture.dbPath);

	const report = transcriptNormalizationReport(fixture.dbPath);
	const preparation = prepareTranscriptNormalization(fixture.dbPath);

	assert.equal(report.transcript_normalization_status, "normalized");
	assert.equal(report.transcript_normalization_schema_version, 12);
	assert.equal(preparation.cutoverReady, false);
	assert.equal(preparation.result.status, "already_normalized");
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

async function normalizationFixture(t: test.TestContext): Promise<{
	readonly root: string;
	readonly dbPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-transcript-normalization-maintenance-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return { root, dbPath: join(root, ".mycli", "sessions.db") };
}
