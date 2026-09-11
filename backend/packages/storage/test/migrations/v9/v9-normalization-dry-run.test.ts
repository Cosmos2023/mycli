import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import {
	analyzeV9TranscriptNormalization,
	StorageFailure,
} from "../../../src/index.ts";
import {
	createRichV9NormalizationFixture,
	RICH_V9_SESSION_IDS,
} from "../../support/v9-normalization-fixtures.ts";

test("reports bounded v9 normalization coverage, exclusions, batches, space, and savings read-only", async (t) => {
	const fixture = await databaseFixture(t);
	createRichV9NormalizationFixture({ dbPath: fixture.dbPath, workspaceRoot: fixture.root });
	const before = await stat(fixture.dbPath);

	const report = analyzeV9TranscriptNormalization({ dbPath: fixture.dbPath, batchSize: 7 });

	const after = await stat(fixture.dbPath);
	assert.equal(report.schemaVersion, 9);
	assert.equal(report.dryRun, true);
	assert.equal(report.sessionCount, 16);
	assert.equal(report.coverage.length, 4);
	assert.equal(report.sourceRowCount, report.coverage.reduce(
		(total, source) => total + source.sourceRowCount,
		0,
	));
	assert.equal(report.coveredSourceRowCount, report.sourceRowCount);
	assert.equal(
		report.normalizableSourceRowCount + report.opaqueSourceRowCount,
		report.sourceRowCount,
	);
	assert.equal(report.opaqueSourceRowCount, 8);
	assert.equal(report.excludedActiveSessionCount, 1);
	assert.ok(report.excludedActiveSourceRowCount > 0);
	assert.equal(report.batchProgress.batchSize, 7);
	assert.equal(report.batchProgress.scannedSourceRowCount, report.sourceRowCount);
	assert.equal(report.batchProgress.stagedSourceRowCount, 0);
	assert.equal(report.batchProgress.completedBatchCount, 0);
	assert.equal(
		report.batchProgress.plannedBatchCount,
		Math.ceil(report.batchProgress.eligibleSourceRowCount / 7),
	);
	assert.equal(
		report.batchProgress.remainingSourceRowCount,
		report.batchProgress.eligibleSourceRowCount,
	);
	assert.ok(report.temporarySpace.estimatedTemporaryPeakBytes > 0);
	assert.ok(report.temporarySpace.requiredFreeBytes > 0);
	assert.ok((report.temporarySpace.availableFreeBytes ?? 0) > 0);
	assert.equal(report.savings.sourcePayloadBytes, report.coverage.reduce(
		(total, source) => total + source.sourcePayloadBytes,
		0,
	));
	assert.ok(report.savings.estimatedLogicalSavingsBytes >= 0);
	assert.equal(report.savings.physicalBytesReducedByDryRun, 0);
	assert.equal(report.savings.explicitVacuumRequired, true);
	assert.equal(after.size, before.size);
	assert.equal(after.mtimeMs, before.mtimeMs);

	const rendered = JSON.stringify(report);
	for (const privateValue of [
		fixture.root,
		RICH_V9_SESSION_IDS.activeRecovery,
		RICH_V9_SESSION_IDS.malformedConversation,
		"legacy system item",
	]) {
		assert.equal(rendered.includes(privateValue), false);
	}
});

test("rejects invalid dry-run batch bounds before opening storage", async (t) => {
	const fixture = await databaseFixture(t);
	for (const batchSize of [0, -1, 10_001, 1.5]) {
		assert.throws(
			() => analyzeV9TranscriptNormalization({ dbPath: fixture.dbPath, batchSize }),
			/batchSize must be between 1 and 10000/u,
		);
	}
});

test("rejects non-v9 storage with bounded dry-run diagnostics", async (t) => {
	const fixture = await databaseFixture(t);
	const database = new Database(fixture.dbPath);
	database.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
	database.prepare("INSERT INTO schema_version (version) VALUES (8)").run();
	database.close();

	assert.throws(
		() => analyzeV9TranscriptNormalization({ dbPath: fixture.dbPath }),
		(error: unknown) => error instanceof StorageFailure
			&& error.diagnostics.expected_version === 9
			&& error.diagnostics.actual_version === 8
			&& !error.message.includes(fixture.dbPath),
	);
});

async function databaseFixture(t: test.TestContext): Promise<{
	readonly root: string;
	readonly dbPath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "mycli-v9-normalization-dry-run-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return { root, dbPath: join(root, "sessions.db") };
}
