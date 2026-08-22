#!/usr/bin/env node

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import {
	analyzeV9TranscriptNormalization,
	applyV9TranscriptNormalizationCutover,
	createV9ProjectionManifest,
	stageV9TranscriptNormalizationBatch,
} from "@mycli/storage";

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 10_000;
let failureStage = "arguments";

const exitCode = await main().catch((error) => {
	process.stderr.write(`${boundedFailure(error, failureStage)}\n`);
	return 1;
});
process.exitCode = exitCode;

async function main() {
	let values;
	try {
		({ values } = parseArgs({
			options: {
				source: { type: "string" },
				"batch-size": { type: "string", default: String(DEFAULT_BATCH_SIZE) },
			},
			strict: true,
			allowPositionals: false,
		}));
	} catch {
		return 64;
	}
	if (!values.source) return 64;
	const batchSize = boundedInteger(values["batch-size"], 1, MAX_BATCH_SIZE);
	if (batchSize === undefined) return 64;

	const sourcePath = resolve(values.source);
	const sourceBefore = await stat(sourcePath);
	const root = await mkdtemp(join(tmpdir(), "mycli-transcript-normalization-benchmark-"));
	const copyPath = join(root, "sessions.db");
	try {
		failureStage = "backup";
		const backupStarted = performance.now();
		await backupDatabase(sourcePath, copyPath);
		const backupMilliseconds = performance.now() - backupStarted;
		const sourceAfterBackup = await stat(sourcePath);
		const sourceUnchanged = sourceBefore.size === sourceAfterBackup.size
			&& sourceBefore.mtimeMs === sourceAfterBackup.mtimeMs;
		if (!sourceUnchanged) throw new Error("source_changed_during_backup");

		failureStage = "report";
		const sourceMetrics = storageMetrics(copyPath);
		const reportStarted = performance.now();
		const report = analyzeV9TranscriptNormalization({ dbPath: copyPath, batchSize });
		const projectionManifest = createV9ProjectionManifest({ dbPath: copyPath });
		const reportMilliseconds = performance.now() - reportStarted;

		let peak = sourceMetrics;
		const sample = () => {
			const current = storageMetrics(copyPath);
			if (current.totalBytes > peak.totalBytes) peak = current;
		};
		let stagingMilliseconds = 0;
		let stagingBatchCount = 0;
		let selectedSourceRows = 0;
		let finalStagingBatch;
		failureStage = "staging";
		for (;;) {
			const started = performance.now();
			const batch = stageV9TranscriptNormalizationBatch({ dbPath: copyPath, batchSize });
			stagingMilliseconds += performance.now() - started;
			stagingBatchCount += 1;
			selectedSourceRows += batch.selectedSourceRowCount;
			finalStagingBatch = batch;
			sample();
			if (batch.complete) break;
			if (batch.selectedSourceRowCount === 0) throw new Error("staging_stalled");
		}
		if (report.excludedActiveSessionCount > 0) {
			const sourceAfterRun = await stat(sourcePath);
			process.stdout.write(`${JSON.stringify({
				schemaVersion: 1,
				status: "blocked_active_sessions",
				source: {
					schemaVersion: report.schemaVersion,
					databaseBytes: sourceBefore.size,
					sessionCount: report.sessionCount,
					sourceRows: report.sourceRowCount,
					sourcePayloadBytes: report.savings.sourcePayloadBytes,
					opaqueSourceRows: report.opaqueSourceRowCount,
					excludedActiveSessions: report.excludedActiveSessionCount,
					excludedActiveSourceRows: report.excludedActiveSourceRowCount,
					projectionErrors: projectionErrorCounts(projectionManifest),
					unchanged: sourceBefore.size === sourceAfterRun.size
						&& sourceBefore.mtimeMs === sourceAfterRun.mtimeMs,
				},
				staging: {
					batchSize,
					plannedBatches: report.batchProgress.plannedBatchCount,
					completedBatches: stagingBatchCount,
					selectedSourceRows,
					stagedEvents: finalStagingBatch?.totalStagedEventCount ?? 0,
					milliseconds: rounded(stagingMilliseconds),
					estimatedTemporaryPeakBytes: report.temporarySpace.estimatedTemporaryPeakBytes,
					requiredFreeBytes: report.temporarySpace.requiredFreeBytes,
					availableFreeBytes: report.temporarySpace.availableFreeBytes,
					actualPeakStorageBytes: peak.totalBytes,
					actualPeakAdditionalBytes: Math.max(0, peak.totalBytes - sourceMetrics.totalBytes),
				},
				timingsMilliseconds: {
					backup: rounded(backupMilliseconds),
					reportAndSourceManifest: rounded(reportMilliseconds),
					staging: rounded(stagingMilliseconds),
				},
			}, null, 2)}\n`);
			return 2;
		}

		failureStage = "cutover_begin";
		const cutoverStarted = performance.now();
		const cutover = applyV9TranscriptNormalizationCutover({
			dbPath: copyPath,
			failpoint: (stage) => {
				failureStage = `cutover_${stage}`;
				sample();
			},
		});
		failureStage = "cutover_complete";
		const cutoverMilliseconds = performance.now() - cutoverStarted;
		sample();
		checkpoint(copyPath);
		const afterCutover = storageMetrics(copyPath);
		const normalized = normalizedMetrics(copyPath);
		const storedManifest = normalizationManifest(copyPath);

		failureStage = "vacuum";
		const vacuumStarted = performance.now();
		vacuum(copyPath);
		const vacuumMilliseconds = performance.now() - vacuumStarted;
		const afterVacuum = storageMetrics(copyPath);
		const sourceAfterRun = await stat(sourcePath);
		const sourceStillUnchanged = sourceBefore.size === sourceAfterRun.size
			&& sourceBefore.mtimeMs === sourceAfterRun.mtimeMs;
		if (!sourceStillUnchanged) throw new Error("source_changed_during_benchmark");

		const result = {
			schemaVersion: 1,
			platform: process.platform,
			arch: process.arch,
			nodeVersion: process.versions.node,
			source: {
				schemaVersion: report.schemaVersion,
				databaseBytes: sourceBefore.size,
				sessionCount: report.sessionCount,
				sourceRows: report.sourceRowCount,
				sourcePayloadBytes: report.savings.sourcePayloadBytes,
				opaqueSourceRows: report.opaqueSourceRowCount,
				excludedActiveSessions: report.excludedActiveSessionCount,
				projectionErrors: projectionErrorCounts(projectionManifest),
				projectionManifestSha256: projectionManifest.manifestSha256,
				providerLedgerSha256: projectionManifest.providerLedger.sha256,
				unchanged: sourceStillUnchanged,
			},
			staging: {
				batchSize,
				batchCount: stagingBatchCount,
				selectedSourceRows,
				milliseconds: rounded(stagingMilliseconds),
				estimatedTemporaryPeakBytes: report.temporarySpace.estimatedTemporaryPeakBytes,
				actualPeakStorageBytes: peak.totalBytes,
				actualPeakAdditionalBytes: Math.max(0, peak.totalBytes - sourceMetrics.totalBytes),
			},
			cutover: {
				milliseconds: rounded(cutoverMilliseconds),
				tailBatches: cutover.tailBatchCount,
				reconciledTailSourceRows: cutover.reconciledTailSourceRowCount,
				installedEvents: cutover.installedEventCount,
				opaqueEvents: normalized.opaqueEvents,
				activeRecoverySessions: normalized.activeRecoverySessions,
				providerSha256: storedManifest.providerSha256,
				readableSha256: storedManifest.readableSha256,
				searchSha256: storedManifest.searchSha256,
				lineageSha256: storedManifest.lineageSha256,
				recoverySha256: storedManifest.recoverySha256,
				providerLedgerSha256: storedManifest.providerLedgerSha256,
				projectionParityValidated: true,
				searchMatchEquivalent: true,
				providerLedgerUnchanged:
					storedManifest.providerLedgerSha256 === projectionManifest.providerLedger.sha256,
				transcriptPayloadBytes: normalized.transcriptPayloadBytes,
				logicalPayloadBytesRemoved: Math.max(
					0,
					report.savings.sourcePayloadBytes - normalized.transcriptPayloadBytes,
				),
				databaseBytes: afterCutover.databaseBytes,
				freelistBytes: normalized.freelistBytes,
			},
			vacuum: {
				performed: true,
				milliseconds: rounded(vacuumMilliseconds),
				databaseBytesBefore: afterCutover.databaseBytes,
				databaseBytesAfter: afterVacuum.databaseBytes,
				physicalReductionBytes: Math.max(
					0,
					sourceBefore.size - afterVacuum.databaseBytes,
				),
				physicalReductionRatio: ratio(
					Math.max(0, sourceBefore.size - afterVacuum.databaseBytes),
					sourceBefore.size,
				),
			},
			timingsMilliseconds: {
				backup: rounded(backupMilliseconds),
				reportAndSourceManifest: rounded(reportMilliseconds),
				staging: rounded(stagingMilliseconds),
				cutover: rounded(cutoverMilliseconds),
				vacuum: rounded(vacuumMilliseconds),
			},
		};
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return 0;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function backupDatabase(sourcePath, copyPath) {
	const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
	try {
		source.pragma("query_only = ON");
		await source.backup(copyPath);
	} finally {
		source.close();
	}
}

function projectionErrorCounts(manifest) {
	const fields = [
		["provider", "providerWindow"],
		["readable", "readableTranscript"],
		["search", "searchDocuments"],
		["lineage", "lineage"],
		["recovery", "recoveryState"],
	];
	return Object.fromEntries(fields.map(([name, field]) => [
		name,
		manifest.sessions.filter((session) => session[field].status === "error").length,
	]));
}

function normalizedMetrics(dbPath) {
	const database = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		const pageSize = pragmaNumber(database, "page_size");
		const freelistCount = pragmaNumber(database, "freelist_count");
		return Object.freeze({
			transcriptPayloadBytes: scalar(database, `
				SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) FROM transcript_events
			`),
			opaqueEvents: scalar(database, `
				SELECT COUNT(*) FROM transcript_events WHERE event_type = 'opaque_legacy'
			`),
			activeRecoverySessions: activeRecoverySessionCount(database),
			freelistBytes: pageSize * freelistCount,
		});
	} finally {
		database.close();
	}
}

function normalizationManifest(dbPath) {
	const database = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		const row = database.prepare(`
			SELECT provider_sha256, readable_sha256, search_sha256, lineage_sha256,
			       recovery_sha256, provider_ledger_sha256
			FROM transcript_normalization_manifest WHERE manifest_id = 1
		`).get();
		if (!row) throw new Error("normalization_manifest_missing");
		return Object.freeze({
			providerSha256: hash(row.provider_sha256),
			readableSha256: hash(row.readable_sha256),
			searchSha256: hash(row.search_sha256),
			lineageSha256: hash(row.lineage_sha256),
			recoverySha256: hash(row.recovery_sha256),
			providerLedgerSha256: hash(row.provider_ledger_sha256),
		});
	} finally {
		database.close();
	}
}

function activeRecoverySessionCount(database) {
	return Number(database.prepare(`
		SELECT COUNT(DISTINCT session_id) FROM (
			SELECT session_id FROM runtime_turns WHERE status = 'in_progress'
			UNION ALL
			SELECT session_id FROM session_state
			WHERE state_key IN ('pending_decision', 'suspended_turn')
		)
	`).pluck().get());
}

function checkpoint(dbPath) {
	const database = new Database(dbPath);
	try {
		database.pragma("wal_checkpoint(TRUNCATE)");
	} finally {
		database.close();
	}
}

function vacuum(dbPath) {
	const database = new Database(dbPath);
	try {
		database.exec("VACUUM");
		database.pragma("wal_checkpoint(TRUNCATE)");
	} finally {
		database.close();
	}
}

function storageMetrics(dbPath) {
	const databaseBytes = fileSize(dbPath);
	const walBytes = fileSize(`${dbPath}-wal`);
	const shmBytes = fileSize(`${dbPath}-shm`);
	return Object.freeze({
		databaseBytes,
		walBytes,
		shmBytes,
		totalBytes: databaseBytes + walBytes + shmBytes,
	});
}

function fileSize(path) {
	try {
		return statSync(path).size;
	} catch (error) {
		if (error?.code === "ENOENT") return 0;
		throw error;
	}
}

function pragmaNumber(database, name) {
	const value = Number(database.pragma(name, { simple: true }));
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_storage_metric");
	return value;
}

function scalar(database, sql) {
	const value = Number(database.prepare(sql).pluck().get());
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid_storage_metric");
	return value;
}

function hash(value) {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
		throw new Error("invalid_manifest_hash");
	}
	return value;
}

function boundedInteger(value, minimum, maximum) {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
		? parsed
		: undefined;
}

function rounded(value) {
	return Math.round(value * 100) / 100;
}

function ratio(numerator, denominator) {
	return denominator > 0 ? Math.round((numerator / denominator) * 1_000_000) / 1_000_000 : 0;
}

function boundedFailure(error, stage) {
	const code = error instanceof Error ? error.message.split(":", 1)[0] : "benchmark_failed";
	return JSON.stringify({
		status: "failed",
		failureStage: stage,
		errorCode: code,
		errorSha256: createHash("sha256")
			.update(error instanceof Error ? error.message : String(error)).digest("hex"),
		...boundedDiagnostics(error),
	});
}

function boundedDiagnostics(error) {
	if (typeof error !== "object" || error === null
		|| typeof error.diagnostics !== "object" || error.diagnostics === null) return {};
	const allowlisted = [
		"session_ordinal",
		"event_ordinal",
		"previous_provider_index",
		"current_provider_index",
		"event_type",
		"source_row_count",
		"mapped_source_row_count",
		"projection",
		"cutover_stage",
		"mismatch_count",
		"first_mismatch_index",
	];
	const diagnostics = Object.fromEntries(allowlisted.flatMap((key) => {
		const value = error.diagnostics[key];
		return typeof value === "string" || typeof value === "number" || value === null
			? [[key, value]]
			: [];
	}));
	return Object.keys(diagnostics).length > 0 ? { diagnostics } : {};
}
