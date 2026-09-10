import { statSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import {
	analyzeV9TranscriptNormalization,
	applyV9TranscriptNormalizationCutover,
	SCHEMA_V10_VERSION,
	SCHEMA_V11_VERSION,
	SCHEMA_V12_VERSION,
	SCHEMA_V13_VERSION,
	SCHEMA_V14_VERSION,
	SCHEMA_VERSION,
	stageV9TranscriptNormalizationBatch,
	StorageFailure,
} from "@mycli/storage";
import type { V9TranscriptNormalizationDryRunReport } from "@mycli/storage";

type JsonObject = Record<string, unknown>;
interface NodeSqliteModule {
	readonly DatabaseSync: new (
		location: string,
		options?: { readonly readOnly?: boolean },
	) => DatabaseSync;
}

const NORMALIZATION_STAGING_TABLES = Object.freeze([
	"transcript_normalization_events",
	"transcript_normalization_batches",
	"transcript_normalization_source_map",
	"transcript_normalization_merge_keys",
	"transcript_normalization_source_conflicts",
] as const);
const nodeRequire = createRequire(import.meta.url);

interface TranscriptNormalizationPreparation {
	readonly result: JsonObject;
	readonly cutoverReady: boolean;
	readonly report?: V9TranscriptNormalizationDryRunReport;
}

export function transcriptNormalizationReport(dbPath: string): JsonObject {
	const version = sessionSchemaVersion(dbPath);
	if (version === SCHEMA_V10_VERSION || version === SCHEMA_V11_VERSION
		|| version === SCHEMA_V12_VERSION || version === SCHEMA_V13_VERSION || version === SCHEMA_V14_VERSION) {
		return Object.freeze({
			transcript_normalization_status: "normalized",
			transcript_normalization_schema_version: version,
			transcript_normalization_dry_run: true,
			physical_bytes_reduced_by_normalization: 0,
			explicit_vacuum_required: true,
		});
	}
	if (version !== SCHEMA_VERSION) throw unsupportedVersion(version);
	return dryRunResult(
		analyzeV9TranscriptNormalization({ dbPath }),
		hasCompleteStagingSchema(dbPath),
	);
}

export function prepareTranscriptNormalization(
	dbPath: string,
): TranscriptNormalizationPreparation {
	const version = sessionSchemaVersion(dbPath);
	if (version === SCHEMA_V10_VERSION || version === SCHEMA_V11_VERSION
		|| version === SCHEMA_V12_VERSION || version === SCHEMA_V13_VERSION || version === SCHEMA_V14_VERSION) {
		return Object.freeze({
			cutoverReady: false,
			result: Object.freeze({
				status: "already_normalized",
				phase: "complete",
				schema_version: version,
				dry_run: false,
				physical_bytes_reduced_by_normalization: 0,
				explicit_vacuum_required: true,
			}),
		});
	}
	if (version !== SCHEMA_VERSION) throw unsupportedVersion(version);

	const report = analyzeV9TranscriptNormalization({ dbPath });
	if (readyForCutover(report) && hasCompleteStagingSchema(dbPath)) {
		return Object.freeze({
			cutoverReady: true,
			report,
			result: Object.freeze({
				status: "ready_for_cutover",
				phase: "cutover",
				schema_version: SCHEMA_VERSION,
				dry_run: false,
				staged_source_rows: report.batchProgress.stagedSourceRowCount,
				remaining_source_rows: 0,
				excluded_active_sessions: 0,
				cutover_ready: true,
			}),
		});
	}

	const batch = stageV9TranscriptNormalizationBatch({
		dbPath,
		batchSize: report.batchProgress.batchSize,
	});
	const cutoverReady = batch.complete && batch.excludedActiveSessionCount === 0;
	return Object.freeze({
		cutoverReady: false,
		report,
		result: Object.freeze({
			status: cutoverReady
				? "ready_for_cutover"
				: batch.excludedActiveSessionCount > 0 && batch.remainingSourceRowCount === 0
					? "blocked_active_sessions"
					: "staging",
			phase: "staging",
			schema_version: batch.schemaVersion,
			dry_run: false,
			batch_id: batch.batchId,
			selected_source_rows: batch.selectedSourceRowCount,
			staged_events: batch.stagedEventCount,
			merged_source_rows: batch.mergedSourceRowCount,
			opaque_source_rows: batch.opaqueSourceRowCount,
			total_staged_source_rows: batch.totalStagedSourceRowCount,
			total_staged_events: batch.totalStagedEventCount,
			remaining_source_rows: batch.remainingSourceRowCount,
			excluded_active_sessions: batch.excludedActiveSessionCount,
			cutover_ready: cutoverReady,
			physical_bytes_reduced_by_normalization: 0,
			explicit_vacuum_required: true,
		}),
	});
}

export function cutoverTranscriptNormalization(
	dbPath: string,
	preparation: TranscriptNormalizationPreparation,
): JsonObject {
	if (!preparation.cutoverReady || !preparation.report) {
		throw new StorageFailure("transcript normalization cutover is not ready");
	}
	const cutover = applyV9TranscriptNormalizationCutover({ dbPath });
	const metrics = optionalSqliteMetrics(dbPath);
	return Object.freeze({
		status: "normalized",
		phase: "cutover",
		schema_version: cutover.schemaVersion,
		dry_run: false,
		tail_batches: cutover.tailBatchCount,
		reconciled_tail_source_rows: cutover.reconciledTailSourceRowCount,
		total_source_rows: cutover.totalSourceRowCount,
		installed_events: cutover.installedEventCount,
		migrated_lineage_rows: cutover.migratedLineageCount,
		migrated_checkpoint_rows: cutover.migratedCheckpointCount,
		source_payload_bytes: preparation.report.savings.sourcePayloadBytes,
		estimated_normalized_payload_bytes:
			preparation.report.savings.estimatedNormalizedPayloadBytes,
		estimated_logical_savings_bytes:
			preparation.report.savings.estimatedLogicalSavingsBytes,
		database_bytes_after_cutover: metrics.databaseBytes,
		reusable_freelist_bytes_after_cutover: metrics.reusableFreelistBytes,
		physical_bytes_reduced_by_normalization: 0,
		explicit_vacuum_required: true,
		backend_restart_required: true,
	});
}

export function transcriptNormalizationFailure(): JsonObject {
	return Object.freeze({
		status: "failed",
		phase: "cutover",
		error_code: "persistence_error",
		backend_restart_required: true,
	});
}

function dryRunResult(
	report: V9TranscriptNormalizationDryRunReport,
	hasCompleteStaging: boolean,
): JsonObject {
	const progress = report.batchProgress;
	const status = report.excludedActiveSessionCount > 0 && progress.remainingSourceRowCount === 0
		? "blocked_active_sessions"
		: progress.remainingSourceRowCount === 0 && hasCompleteStaging
			? "ready_for_cutover"
			: hasCompleteStaging || progress.stagedSourceRowCount > 0
				? "staging"
				: "not_started";
	return Object.freeze({
		transcript_normalization_status: status,
		transcript_normalization_schema_version: report.schemaVersion,
		transcript_normalization_dry_run: report.dryRun,
		transcript_source_rows: report.sourceRowCount,
		transcript_staged_source_rows: progress.stagedSourceRowCount,
		transcript_remaining_source_rows: progress.remainingSourceRowCount,
		transcript_completed_batches: progress.completedBatchCount,
		transcript_opaque_source_rows: report.opaqueSourceRowCount,
		transcript_excluded_active_sessions: report.excludedActiveSessionCount,
		transcript_estimated_temporary_peak_bytes: report.temporarySpace.estimatedTemporaryPeakBytes,
		transcript_required_free_bytes: report.temporarySpace.requiredFreeBytes,
		transcript_available_free_bytes: report.temporarySpace.availableFreeBytes,
		transcript_sufficient_free_space: report.temporarySpace.sufficientFreeSpace,
		transcript_source_payload_bytes: report.savings.sourcePayloadBytes,
		transcript_estimated_normalized_payload_bytes:
			report.savings.estimatedNormalizedPayloadBytes,
		transcript_estimated_logical_savings_bytes:
			report.savings.estimatedLogicalSavingsBytes,
		transcript_reusable_freelist_bytes: report.savings.currentReusableFreelistBytes,
		physical_bytes_reduced_by_normalization: report.savings.physicalBytesReducedByDryRun,
		explicit_vacuum_required: report.savings.explicitVacuumRequired,
	});
}

function readyForCutover(report: V9TranscriptNormalizationDryRunReport): boolean {
	return report.excludedActiveSessionCount === 0
		&& report.batchProgress.remainingSourceRowCount === 0;
}

function hasCompleteStagingSchema(dbPath: string): boolean {
	return withReadOnlyDatabase(dbPath, (database) => {
		const placeholders = NORMALIZATION_STAGING_TABLES.map(() => "?").join(",");
		const row = database.prepare(`
			SELECT COUNT(*) AS count FROM sqlite_master
			WHERE type = 'table' AND name IN (${placeholders})
		`).get(...NORMALIZATION_STAGING_TABLES);
		return Number(row?.count ?? 0) === NORMALIZATION_STAGING_TABLES.length;
	});
}

function sessionSchemaVersion(dbPath: string): number {
	return withReadOnlyDatabase(dbPath, (database) => {
		const rows = database.prepare("SELECT version FROM schema_version").all();
		if (rows.length !== 1 || typeof rows[0]?.version !== "number"
			|| !Number.isSafeInteger(rows[0].version)) {
			throw new StorageFailure("session schema version marker is invalid");
		}
		return rows[0].version;
	});
}

function sqliteMetrics(dbPath: string): Readonly<{
	readonly databaseBytes: number;
	readonly reusableFreelistBytes: number;
}> {
	return withReadOnlyDatabase(dbPath, (database) => {
		const pageSize = pragmaNumber(database, "page_size");
		return Object.freeze({
			databaseBytes: statSync(dbPath).size,
			reusableFreelistBytes: pragmaNumber(database, "freelist_count") * pageSize,
		});
	});
}

function optionalSqliteMetrics(dbPath: string): Readonly<{
	readonly databaseBytes: number | null;
	readonly reusableFreelistBytes: number | null;
}> {
	try {
		return sqliteMetrics(dbPath);
	} catch {
		return Object.freeze({ databaseBytes: null, reusableFreelistBytes: null });
	}
}

function pragmaNumber(database: DatabaseSync, name: "page_size" | "freelist_count"): number {
	const row = database.prepare(`PRAGMA ${name}`).get();
	const value = row ? Object.values(row)[0] : undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new StorageFailure("session storage metrics are invalid");
	}
	return value;
}

function withReadOnlyDatabase<T>(dbPath: string, operation: (database: DatabaseSync) => T): T {
	let database: DatabaseSync | undefined;
	try {
		const { DatabaseSync } = nodeRequire("node:sqlite") as NodeSqliteModule;
		database = new DatabaseSync(dbPath, { readOnly: true });
		database.exec("PRAGMA query_only = ON");
		return operation(database);
	} catch (error) {
		if (error instanceof StorageFailure) throw error;
		throw new StorageFailure("session storage is not readable");
	} finally {
		database?.close();
	}
}

function unsupportedVersion(actualVersion: number): StorageFailure {
	return new StorageFailure("unsupported session schema version for transcript normalization", {
		expected_version: SCHEMA_VERSION,
		actual_version: actualVersion,
	});
}
