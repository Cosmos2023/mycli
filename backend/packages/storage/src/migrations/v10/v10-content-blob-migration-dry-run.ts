import Database from "better-sqlite3";
import { StorageFailure } from "../../sessions/session-store.ts";
import {
	analyzeV10ContentBlobs,
	type V10ContentBlobAnalysis,
} from "./v10-content-blob-analyzer.ts";
import { V10_CONTENT_BLOB_MIGRATION_STAGING_TABLES } from "./v10-content-blob-migration-staging.ts";

const DEFAULT_BATCH_SIZE = 250;
const MAX_BATCH_SIZE = 5_000;

export interface V10ContentBlobMigrationDryRunOptions {
	readonly dbPath: string;
	readonly batchSize?: number;
}

export interface V10ContentBlobMigrationBatchPlan {
	readonly batchSize: number;
	readonly transcriptEventRowCount: number;
	readonly modelInputBlobRowCount: number;
	readonly sourceRowCount: number;
	readonly plannedBatchCount: number;
	readonly stagingPresent: boolean;
	readonly completedBatchCount: number;
	readonly stagedSourceRowCount: number;
	readonly unresolvedSourceConflictCount: number;
	readonly remainingSourceRowCount: number;
}

export interface V10ContentBlobFtsRebuildWork {
	readonly eligibleEventCount: number;
	readonly canonicalPayloadBytes: number;
}

export interface V10ContentBlobActiveWriterState {
	readonly activeRuntimeTurnCount: number;
	readonly activeRecoveryStateCount: number;
	readonly activeSessionCount: number;
	readonly blocksCutover: boolean;
}

export interface V10ContentBlobTemporarySpace {
	readonly estimatedStagingBytes: number;
	readonly estimatedWalBytes: number;
	readonly safetyBytes: number;
	readonly reusableFreelistBytes: number;
	readonly estimatedTemporaryPeakBytes: number;
	readonly requiredFreeBytes: number;
	readonly availableFreeBytes: number | null;
	readonly sufficientFreeSpace: boolean | null;
}

export interface V10ContentBlobMigrationDryRunReport {
	readonly schemaVersion: 10;
	readonly targetSchemaVersion: 11;
	readonly dryRun: true;
	readonly analysis: V10ContentBlobAnalysis;
	readonly batchPlan: V10ContentBlobMigrationBatchPlan;
	readonly ftsRebuild: V10ContentBlobFtsRebuildWork;
	readonly activeWriters: V10ContentBlobActiveWriterState;
	readonly temporarySpace: V10ContentBlobTemporarySpace;
}

interface CountRow {
	readonly count: unknown;
}

interface CountAndBytesRow {
	readonly count: unknown;
	readonly bytes: unknown;
}

export function analyzeV10ContentBlobMigration(
	options: V10ContentBlobMigrationDryRunOptions,
): V10ContentBlobMigrationDryRunReport {
	const batchSize = boundedBatchSize(options.batchSize);
	const analysis = analyzeV10ContentBlobs({ dbPath: options.dbPath });
	let database: Database.Database;
	try {
		database = new Database(options.dbPath, { readonly: true, fileMustExist: true });
		database.pragma("query_only = ON");
	} catch {
		throw new StorageFailure("unable to open session storage for content-blob migration dry-run");
	}
	try {
		const transcriptEventRowCount = count(
			database,
			"SELECT COUNT(*) AS count FROM transcript_events",
		);
		const modelInputBlobRowCount = count(
			database,
			"SELECT COUNT(*) AS count FROM model_input_blobs",
		);
		const sourceRowCount = transcriptEventRowCount + modelInputBlobRowCount;
		const batchPlan = migrationBatchPlan(database, {
			batchSize,
			transcriptEventRowCount,
			modelInputBlobRowCount,
			sourceRowCount,
		});
		const ftsRebuild = ftsRebuildWork(database);
		const activeWriters = activeWriterState(database);
		const headroom = analysis.migrationHeadroom;
		return Object.freeze({
			schemaVersion: 10 as const,
			targetSchemaVersion: 11 as const,
			dryRun: true as const,
			analysis,
			batchPlan,
			ftsRebuild,
			activeWriters,
			temporarySpace: Object.freeze({
				estimatedStagingBytes: headroom.estimatedStagingBytes,
				estimatedWalBytes: headroom.estimatedWalBytes,
				safetyBytes: headroom.safetyBytes,
				reusableFreelistBytes: headroom.reusableFreelistBytes,
				estimatedTemporaryPeakBytes: headroom.estimatedStagingBytes
					+ headroom.estimatedWalBytes + headroom.safetyBytes,
				requiredFreeBytes: headroom.requiredFreeBytes,
				availableFreeBytes: headroom.availableFreeBytes,
				sufficientFreeSpace: headroom.sufficientFreeSpace,
			}),
		});
	} catch (error) {
		if (error instanceof StorageFailure) throw error;
		throw new StorageFailure("content-blob migration dry-run failed");
	} finally {
		database.close();
	}
}

function migrationBatchPlan(
	database: Database.Database,
	counts: Readonly<{
		readonly batchSize: number;
		readonly transcriptEventRowCount: number;
		readonly modelInputBlobRowCount: number;
		readonly sourceRowCount: number;
	}>,
): V10ContentBlobMigrationBatchPlan {
	const existingTableCount = nonNegativeInteger((database.prepare(`
		SELECT COUNT(*) AS count FROM sqlite_master
		WHERE type = 'table' AND name IN (
			${V10_CONTENT_BLOB_MIGRATION_STAGING_TABLES.map(() => "?").join(", ")}
		)
	`).get(...V10_CONTENT_BLOB_MIGRATION_STAGING_TABLES) as CountRow).count);
	if (existingTableCount !== 0
		&& existingTableCount !== V10_CONTENT_BLOB_MIGRATION_STAGING_TABLES.length) {
		throw new StorageFailure("content-blob migration staging schema is incomplete", {
			expected_table_count: V10_CONTENT_BLOB_MIGRATION_STAGING_TABLES.length,
			actual_table_count: existingTableCount,
		});
	}
	if (existingTableCount === 0) {
		return Object.freeze({
			...counts,
			plannedBatchCount: Math.ceil(counts.sourceRowCount / counts.batchSize),
			stagingPresent: false,
			completedBatchCount: 0,
			stagedSourceRowCount: 0,
			unresolvedSourceConflictCount: 0,
			remainingSourceRowCount: counts.sourceRowCount,
		});
	}
	const completedBatchCount = count(database, `
		SELECT COUNT(*) AS count FROM content_blob_migration_batches
		WHERE completed_at IS NOT NULL AND schema_version_after = 10
	`);
	const stagedTranscriptEventCount = count(
		database,
		"SELECT COUNT(*) AS count FROM content_blob_migration_event_source_map",
	);
	const stagedModelInputBlobCount = count(
		database,
		"SELECT COUNT(*) AS count FROM content_blob_migration_model_input_source_map",
	);
	const remainingSourceRowCount = count(database, `
		SELECT (
			SELECT COUNT(*) FROM transcript_events AS events
			LEFT JOIN content_blob_migration_event_source_map AS mapped
			  ON mapped.sequence_no = events.sequence_no
			WHERE mapped.sequence_no IS NULL
		) + (
			SELECT COUNT(*) FROM model_input_blobs AS owner
			LEFT JOIN content_blob_migration_model_input_source_map AS mapped
			  ON mapped.blob_id = owner.blob_id
			WHERE mapped.blob_id IS NULL
		) AS count
	`);
	return Object.freeze({
		...counts,
		plannedBatchCount: completedBatchCount
			+ Math.ceil(remainingSourceRowCount / counts.batchSize),
		stagingPresent: true,
		completedBatchCount,
		stagedSourceRowCount: stagedTranscriptEventCount + stagedModelInputBlobCount,
		unresolvedSourceConflictCount: count(
			database,
			"SELECT COUNT(*) AS count FROM content_blob_migration_source_conflicts",
		),
		remainingSourceRowCount,
	});
}

function ftsRebuildWork(database: Database.Database): V10ContentBlobFtsRebuildWork {
	const row = database.prepare(`
		SELECT COUNT(*) AS count,
		       COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS bytes
		FROM transcript_events AS events
		WHERE events.model_visible = 1 AND (
			(events.event_type IN (
				'user_input', 'assistant_output', 'assistant_tool_call_batch', 'tool_result', 'context'
			) AND COALESCE(
				json_extract(events.payload_json, '$.payload.readableProjection.searchVisible'), 1
			) != 0)
			OR (events.event_type = 'opaque_legacy'
				AND json_extract(events.payload_json, '$.payload.sourceKind') = 'conversation_messages')
		)
	`).get() as CountAndBytesRow;
	return Object.freeze({
		eligibleEventCount: nonNegativeInteger(row.count),
		canonicalPayloadBytes: nonNegativeInteger(row.bytes),
	});
}

function activeWriterState(database: Database.Database): V10ContentBlobActiveWriterState {
	const activeRuntimeTurnCount = count(database, `
		SELECT COUNT(*) AS count FROM runtime_turns WHERE status = 'in_progress'
	`);
	const activeRecoveryStateCount = count(database, `
		SELECT COUNT(*) AS count FROM session_state
		WHERE state_key IN ('pending_decision', 'suspended_turn', 'node_effect_checkpoint')
	`);
	const activeSessionCount = count(database, `
		SELECT COUNT(*) AS count FROM (
			SELECT session_id FROM runtime_turns WHERE status = 'in_progress'
			UNION
			SELECT session_id FROM session_state
			WHERE state_key IN ('pending_decision', 'suspended_turn', 'node_effect_checkpoint')
		)
	`);
	return Object.freeze({
		activeRuntimeTurnCount,
		activeRecoveryStateCount,
		activeSessionCount,
		blocksCutover: activeSessionCount > 0,
	});
}

function boundedBatchSize(value: number | undefined): number {
	const candidate = value ?? DEFAULT_BATCH_SIZE;
	if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > MAX_BATCH_SIZE) {
		throw new RangeError(`batchSize must be between 1 and ${MAX_BATCH_SIZE}`);
	}
	return candidate;
}

function count(database: Database.Database, sql: string): number {
	return nonNegativeInteger((database.prepare(sql).get() as CountRow).count);
}

function nonNegativeInteger(value: unknown): number {
	const candidate = Number(value);
	if (!Number.isSafeInteger(candidate) || candidate < 0) {
		throw new StorageFailure("content-blob migration metric is invalid");
	}
	return candidate;
}
