import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import {
	analyzeV10ContentBlobMigration,
	applyV10ContentBlobMigrationCutover,
	SCHEMA_V10_VERSION,
	SCHEMA_V11_VERSION,
	SCHEMA_V12_VERSION,
	SCHEMA_VERSION,
	stageV10ContentBlobMigrationBatch,
	StorageFailure,
} from "@mycli/storage";
import type { V10ContentBlobMigrationDryRunReport } from "@mycli/storage";

type JsonObject = Record<string, unknown>;

interface NodeSqliteModule {
	readonly DatabaseSync: new (
		path: string,
		options?: Readonly<{ readOnly?: boolean }>,
	) => DatabaseSync;
}

const nodeRequire = createRequire(import.meta.url);

export interface ContentBlobMigrationPreparation {
	readonly result: JsonObject;
	readonly cutoverReady: boolean;
	readonly report?: V10ContentBlobMigrationDryRunReport;
}

export function contentBlobMigrationReport(dbPath: string): JsonObject {
	const version = sessionSchemaVersion(dbPath);
	if (version === SCHEMA_VERSION) return requiresTranscriptNormalization(true);
	if (version === SCHEMA_V11_VERSION || version === SCHEMA_V12_VERSION) {
		return Object.freeze({
			content_blob_migration_status: "blob_backed",
			content_blob_migration_schema_version: version,
			content_blob_migration_dry_run: true,
			physical_bytes_reduced_by_content_blobs: 0,
			explicit_vacuum_required: true,
		});
	}
	if (version !== SCHEMA_V10_VERSION) throw unsupportedVersion(version);
	return dryRunResult(analyzeV10ContentBlobMigration({ dbPath }));
}

export function prepareContentBlobMigration(
	dbPath: string,
): ContentBlobMigrationPreparation {
	const version = sessionSchemaVersion(dbPath);
	if (version === SCHEMA_VERSION) {
		return Object.freeze({
			cutoverReady: false,
			result: requiresTranscriptNormalization(false),
		});
	}
	if (version === SCHEMA_V11_VERSION || version === SCHEMA_V12_VERSION) {
		return Object.freeze({
			cutoverReady: false,
			result: Object.freeze({
				status: "already_blob_backed",
				phase: "complete",
				schema_version: version,
				dry_run: false,
				physical_bytes_reduced_by_content_blobs: 0,
				explicit_vacuum_required: true,
			}),
		});
	}
	if (version !== SCHEMA_V10_VERSION) throw unsupportedVersion(version);

	const report = analyzeV10ContentBlobMigration({ dbPath });
	if (readyForCutover(report)) {
		return Object.freeze({
			cutoverReady: true,
			report,
			result: Object.freeze({
				status: "ready_for_cutover",
				phase: "cutover",
				schema_version: SCHEMA_V10_VERSION,
				target_schema_version: SCHEMA_V11_VERSION,
				dry_run: false,
				staged_source_rows: report.batchPlan.stagedSourceRowCount,
				remaining_source_rows: 0,
				active_sessions: 0,
				cutover_ready: true,
			}),
		});
	}
	if (report.temporarySpace.sufficientFreeSpace === false) {
		return Object.freeze({
			cutoverReady: false,
			report,
			result: Object.freeze({
				status: "insufficient_space",
				phase: "staging",
				schema_version: SCHEMA_V10_VERSION,
				target_schema_version: SCHEMA_V11_VERSION,
				dry_run: false,
				required_free_bytes: report.temporarySpace.requiredFreeBytes,
				available_free_bytes: report.temporarySpace.availableFreeBytes,
				cutover_ready: false,
			}),
		});
	}

	const batch = stageV10ContentBlobMigrationBatch({
		dbPath,
		batchSize: report.batchPlan.batchSize,
	});
	const blocked = batch.complete && report.activeWriters.blocksCutover;
	return Object.freeze({
		cutoverReady: false,
		report,
		result: Object.freeze({
			status: blocked
				? "blocked_active_sessions"
				: batch.complete
					? "ready_for_cutover"
					: "staging",
			phase: "staging",
			schema_version: batch.schemaVersion,
			target_schema_version: batch.targetSchemaVersion,
			dry_run: false,
			batch_id: batch.batchId,
			selected_source_rows: batch.selectedSourceRowCount,
			staged_transcript_events: batch.selectedTranscriptEventCount,
			staged_model_input_blobs: batch.selectedModelInputBlobCount,
			staged_references: batch.stagedReferenceCount,
			new_content_blobs: batch.newContentBlobCount,
			new_raw_bytes: batch.newRawBytes,
			new_stored_bytes: batch.newStoredBytes,
			total_staged_source_rows: batch.totalStagedSourceRowCount,
			total_staged_references: batch.totalStagedReferenceCount,
			total_staged_content_blobs: batch.totalStagedContentBlobCount,
			remaining_source_rows: batch.remainingSourceRowCount,
			active_sessions: report.activeWriters.activeSessionCount,
			cutover_ready: batch.complete && !blocked,
			physical_bytes_reduced_by_content_blobs: 0,
			explicit_vacuum_required: true,
		}),
	});
}

export function cutoverContentBlobMigration(
	dbPath: string,
	preparation: ContentBlobMigrationPreparation,
): JsonObject {
	if (!preparation.cutoverReady || !preparation.report) {
		throw new StorageFailure("content-blob migration cutover is not ready");
	}
	const cutover = applyV10ContentBlobMigrationCutover({ dbPath });
	return Object.freeze({
		status: "blob_backed",
		phase: "cutover",
		schema_version: cutover.schemaVersion,
		dry_run: false,
		tail_source_rows: cutover.tailSourceRowCount,
		migrated_transcript_events: cutover.migratedTranscriptEventCount,
		migrated_model_input_blobs: cutover.migratedModelInputBlobCount,
		installed_content_blobs: cutover.installedContentBlobCount,
		installed_references: cutover.installedReferenceCount,
		indexed_events: cutover.indexedEventCount,
		unique_raw_bytes: cutover.uniqueRawBytes,
		stored_bytes: cutover.storedBytes,
		parity_validated: cutover.parityValidated,
		staging_discarded: cutover.stagingDiscarded,
		physical_bytes_reduced_by_content_blobs: 0,
		explicit_vacuum_required: true,
		backend_restart_required: true,
	});
}

export function contentBlobMigrationFailure(): JsonObject {
	return Object.freeze({
		status: "failed",
		phase: "cutover",
		error_code: "persistence_error",
		backend_restart_required: true,
	});
}

function dryRunResult(report: V10ContentBlobMigrationDryRunReport): JsonObject {
	const progress = report.batchPlan;
	const status = report.activeWriters.blocksCutover && progress.remainingSourceRowCount === 0
		? "blocked_active_sessions"
		: progress.remainingSourceRowCount === 0 && progress.stagingPresent
			? "ready_for_cutover"
			: progress.stagingPresent || progress.stagedSourceRowCount > 0
				? "staging"
				: "not_started";
	return Object.freeze({
		content_blob_migration_status: status,
		content_blob_migration_schema_version: report.schemaVersion,
		content_blob_migration_target_schema_version: report.targetSchemaVersion,
		content_blob_migration_dry_run: report.dryRun,
		content_blob_source_rows: progress.sourceRowCount,
		content_blob_staged_source_rows: progress.stagedSourceRowCount,
		content_blob_remaining_source_rows: progress.remainingSourceRowCount,
		content_blob_completed_batches: progress.completedBatchCount,
		content_blob_active_sessions: report.activeWriters.activeSessionCount,
		content_blob_eligible_reference_bytes: report.analysis.eligibleReferenceBytes,
		content_blob_unique_raw_bytes: report.analysis.uniqueRawBytes,
		content_blob_estimated_stored_bytes: report.analysis.estimatedStoredBytes,
		content_blob_compression_savings_bytes: report.analysis.compressionSavingsBytes,
		content_blob_duplicate_reference_bytes: report.analysis.duplicateReferenceBytes,
		content_blob_invalid_payload_rows: report.analysis.invalidPayloadRowCount,
		content_blob_estimated_temporary_peak_bytes:
			report.temporarySpace.estimatedTemporaryPeakBytes,
		content_blob_required_free_bytes: report.temporarySpace.requiredFreeBytes,
		content_blob_available_free_bytes: report.temporarySpace.availableFreeBytes,
		content_blob_sufficient_free_space: report.temporarySpace.sufficientFreeSpace,
		content_blob_reusable_freelist_bytes: report.temporarySpace.reusableFreelistBytes,
		physical_bytes_reduced_by_content_blobs: 0,
		explicit_vacuum_required: true,
	});
}

function readyForCutover(report: V10ContentBlobMigrationDryRunReport): boolean {
	return report.batchPlan.stagingPresent
		&& report.batchPlan.remainingSourceRowCount === 0
		&& report.batchPlan.unresolvedSourceConflictCount === 0
		&& !report.activeWriters.blocksCutover;
}

function requiresTranscriptNormalization(dryRun: boolean): JsonObject {
	return Object.freeze({
		...(dryRun
			? {
				content_blob_migration_status: "requires_transcript_normalization",
				content_blob_migration_schema_version: SCHEMA_VERSION,
				content_blob_migration_target_schema_version: SCHEMA_V11_VERSION,
				content_blob_migration_dry_run: true,
			}
			: {
				status: "requires_transcript_normalization",
				phase: "precondition",
				schema_version: SCHEMA_VERSION,
				target_schema_version: SCHEMA_V11_VERSION,
				dry_run: false,
			}),
		physical_bytes_reduced_by_content_blobs: 0,
		explicit_vacuum_required: true,
	});
}

function sessionSchemaVersion(dbPath: string): number {
	let database: DatabaseSync | undefined;
	try {
		const { DatabaseSync: OpenDatabase } = nodeRequire("node:sqlite") as NodeSqliteModule;
		database = new OpenDatabase(dbPath, { readOnly: true });
		database.exec("PRAGMA query_only = ON");
		const rows = database.prepare("SELECT version FROM schema_version").all();
		if (rows.length !== 1 || typeof rows[0]?.version !== "number"
			|| !Number.isSafeInteger(rows[0].version)) {
			throw new StorageFailure("session schema version marker is invalid");
		}
		return rows[0].version;
	} catch (error) {
		if (error instanceof StorageFailure) throw error;
		throw new StorageFailure("session schema version marker is not readable");
	} finally {
		database?.close();
	}
}

function unsupportedVersion(version: number): StorageFailure {
	return new StorageFailure("content-blob migration requires schema version 10", {
		expected_version: SCHEMA_V10_VERSION,
		actual_version: version,
	});
}
