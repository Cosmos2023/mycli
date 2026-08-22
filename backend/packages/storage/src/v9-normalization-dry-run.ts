import Database from "better-sqlite3";
import { StorageFailure } from "./session-store.ts";
import {
	analyzeV9TranscriptStorage,
	type V9TranscriptLegacyShape,
	type V9TranscriptMigrationHeadroom,
	type V9TranscriptTableName,
} from "./v9-transcript-analyzer.ts";

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 10_000;
const OPAQUE_SHAPES = new Set<V9TranscriptLegacyShape>([
	"unknown_json",
	"invalid_shape",
	"invalid_json",
]);

const SOURCE_TABLES: readonly Readonly<{
	readonly table: V9TranscriptTableName;
	readonly payloadColumn: "payload_json" | "summary_text";
}>[] = Object.freeze([
	{ table: "conversation_messages", payloadColumn: "payload_json" },
	{ table: "history_items", payloadColumn: "payload_json" },
	{ table: "turn_rollouts", payloadColumn: "payload_json" },
	{ table: "session_summaries", payloadColumn: "summary_text" },
]);

export interface AnalyzeV9TranscriptNormalizationOptions {
	readonly dbPath: string;
	readonly batchSize?: number;
}

export interface V9TranscriptNormalizationSourceCoverage {
	readonly source: V9TranscriptTableName;
	readonly sourceRowCount: number;
	readonly sourcePayloadBytes: number;
	readonly normalizableRowCount: number;
	readonly opaqueRowCount: number;
	readonly excludedActiveRowCount: number;
	readonly excludedActivePayloadBytes: number;
}

export interface V9TranscriptNormalizationBatchProgress {
	readonly batchSize: number;
	readonly scannedSourceRowCount: number;
	readonly eligibleSourceRowCount: number;
	readonly plannedBatchCount: number;
	readonly completedBatchCount: number;
	readonly stagedSourceRowCount: number;
	readonly remainingSourceRowCount: number;
}

export interface V9TranscriptNormalizationSavings {
	readonly sourcePayloadBytes: number;
	readonly estimatedNormalizedPayloadBytes: number;
	readonly estimatedLogicalSavingsBytes: number;
	readonly estimatedLogicalSavingsRatio: number;
	readonly currentDatabaseBytes: number;
	readonly currentReusableFreelistBytes: number;
	readonly physicalBytesReducedByDryRun: 0;
	readonly estimatedPhysicalReductionAfterVacuumBytes: number;
	readonly explicitVacuumRequired: true;
}

export interface V9TranscriptNormalizationTemporarySpace extends V9TranscriptMigrationHeadroom {
	readonly estimatedTemporaryPeakBytes: number;
}

export interface V9TranscriptNormalizationDryRunReport {
	readonly schemaVersion: 9;
	readonly dryRun: true;
	readonly sessionCount: number;
	readonly sourceRowCount: number;
	readonly coveredSourceRowCount: number;
	readonly normalizableSourceRowCount: number;
	readonly opaqueSourceRowCount: number;
	readonly excludedActiveSessionCount: number;
	readonly excludedActiveSourceRowCount: number;
	readonly coverage: readonly V9TranscriptNormalizationSourceCoverage[];
	readonly batchProgress: V9TranscriptNormalizationBatchProgress;
	readonly temporarySpace: V9TranscriptNormalizationTemporarySpace;
	readonly savings: V9TranscriptNormalizationSavings;
}

interface CountAndBytesRow {
	readonly row_count: unknown;
	readonly payload_bytes: unknown;
}

export function analyzeV9TranscriptNormalization(
	options: AnalyzeV9TranscriptNormalizationOptions,
): V9TranscriptNormalizationDryRunReport {
	const batchSize = boundedBatchSize(options.batchSize);
	const analysis = analyzeV9TranscriptStorage({ dbPath: options.dbPath });
	let database: Database.Database;
	try {
		database = new Database(options.dbPath, { readonly: true, fileMustExist: true });
		database.pragma("query_only = ON");
	} catch {
		throw new StorageFailure("unable to open session storage for normalization dry-run");
	}

	try {
		const excludedActiveSessionCount = activeSessionCount(database);
		const coverage = Object.freeze(SOURCE_TABLES.map((definition) => {
			const metrics = analysis.tables.find((table) => table.table === definition.table);
			if (!metrics) throw new StorageFailure("v9 normalization source coverage is incomplete");
			const opaqueRowCount = analysis.legacyShapes
				.filter((shape) => shape.table === definition.table && OPAQUE_SHAPES.has(shape.shape))
				.reduce((total, shape) => total + shape.rowCount, 0);
			const excluded = excludedActiveRows(database, definition);
			return Object.freeze({
				source: definition.table,
				sourceRowCount: metrics.rowCount,
				sourcePayloadBytes: metrics.payloadBytes,
				normalizableRowCount: metrics.rowCount - opaqueRowCount,
				opaqueRowCount,
				excludedActiveRowCount: nonNegativeInteger(excluded.row_count),
				excludedActivePayloadBytes: nonNegativeInteger(excluded.payload_bytes),
			});
		}));
		const sessionCount = count(database, "SELECT COUNT(*) AS count FROM sessions");
		const sourceRowCount = sum(coverage, (item) => item.sourceRowCount);
		const normalizableSourceRowCount = sum(coverage, (item) => item.normalizableRowCount);
		const opaqueSourceRowCount = sum(coverage, (item) => item.opaqueRowCount);
		const excludedActiveSourceRowCount = sum(coverage, (item) => item.excludedActiveRowCount);
		const eligibleSourceRowCount = Math.max(0, sourceRowCount - excludedActiveSourceRowCount);
		const batchProgress = normalizationBatchProgress(
			database,
			batchSize,
			sourceRowCount,
			eligibleSourceRowCount,
		);
		const temporarySpace = Object.freeze({
			...analysis.migrationHeadroom,
			estimatedTemporaryPeakBytes:
				analysis.migrationHeadroom.estimatedStagingBytes
				+ analysis.migrationHeadroom.estimatedWalBytes
				+ analysis.migrationHeadroom.safetyBytes,
		});
		const estimatedLogicalSavingsBytes = Math.max(
			0,
			analysis.totalPayloadBytes - analysis.migrationHeadroom.estimatedNormalizedPayloadBytes,
		);
		return Object.freeze({
			schemaVersion: 9 as const,
			dryRun: true as const,
			sessionCount,
			sourceRowCount,
			coveredSourceRowCount: sourceRowCount,
			normalizableSourceRowCount,
			opaqueSourceRowCount,
			excludedActiveSessionCount,
			excludedActiveSourceRowCount,
			coverage,
			batchProgress,
			temporarySpace,
			savings: Object.freeze({
				sourcePayloadBytes: analysis.totalPayloadBytes,
				estimatedNormalizedPayloadBytes:
					analysis.migrationHeadroom.estimatedNormalizedPayloadBytes,
				estimatedLogicalSavingsBytes,
				estimatedLogicalSavingsRatio: ratio(
					estimatedLogicalSavingsBytes,
					analysis.totalPayloadBytes,
				),
				currentDatabaseBytes: analysis.databaseBytes,
				currentReusableFreelistBytes: analysis.migrationHeadroom.reusableFreelistBytes,
				physicalBytesReducedByDryRun: 0 as const,
				estimatedPhysicalReductionAfterVacuumBytes: Math.min(
					estimatedLogicalSavingsBytes,
					analysis.databaseBytes,
				),
				explicitVacuumRequired: true as const,
			}),
		});
	} catch (error) {
		if (error instanceof StorageFailure) throw error;
		throw new StorageFailure("v9 transcript normalization dry-run failed");
	} finally {
		database.close();
	}
}

function normalizationBatchProgress(
	database: Database.Database,
	batchSize: number,
	sourceRowCount: number,
	eligibleSourceRowCount: number,
): V9TranscriptNormalizationBatchProgress {
	const objects = database.prepare(`
		SELECT name FROM sqlite_master
		WHERE type = 'table' AND name IN (
			'transcript_normalization_source_map',
			'transcript_normalization_batches'
		)
	`).all() as readonly { readonly name: unknown }[];
	if (objects.length === 0) {
		return Object.freeze({
			batchSize,
			scannedSourceRowCount: sourceRowCount,
			eligibleSourceRowCount,
			plannedBatchCount: Math.ceil(eligibleSourceRowCount / batchSize),
			completedBatchCount: 0,
			stagedSourceRowCount: 0,
			remainingSourceRowCount: eligibleSourceRowCount,
		});
	}
	if (objects.length !== 2) {
		throw new StorageFailure("v9 normalization staging progress is incomplete");
	}
	const stagedSourceRowCount = count(
		database,
		"SELECT COUNT(*) AS count FROM transcript_normalization_source_map",
	);
	const completedBatchCount = count(database, `
		SELECT COUNT(*) AS count FROM transcript_normalization_batches
		WHERE completed_at IS NOT NULL AND schema_version_after = 9
	`);
	const stagedEligibleSourceRowCount = count(database, `
		WITH active_sessions AS (
			SELECT session_id FROM runtime_turns WHERE status = 'in_progress'
			UNION
			SELECT session_id FROM session_state
			WHERE state_key IN ('pending_decision', 'suspended_turn', 'node_effect_checkpoint')
		), staged AS (
			SELECT mapped.source_rowid
			FROM transcript_normalization_source_map AS mapped
			JOIN conversation_messages AS source ON source.rowid = mapped.source_rowid
			WHERE mapped.source_kind = 'conversation_messages'
			  AND source.session_id NOT IN (SELECT session_id FROM active_sessions)
			UNION ALL
			SELECT mapped.source_rowid
			FROM transcript_normalization_source_map AS mapped
			JOIN history_items AS source ON source.rowid = mapped.source_rowid
			WHERE mapped.source_kind = 'history_items'
			  AND source.session_id NOT IN (SELECT session_id FROM active_sessions)
			UNION ALL
			SELECT mapped.source_rowid
			FROM transcript_normalization_source_map AS mapped
			JOIN turn_rollouts AS source ON source.rowid = mapped.source_rowid
			WHERE mapped.source_kind = 'turn_rollouts'
			  AND source.session_id NOT IN (SELECT session_id FROM active_sessions)
			UNION ALL
			SELECT mapped.source_rowid
			FROM transcript_normalization_source_map AS mapped
			JOIN session_summaries AS source ON source.rowid = mapped.source_rowid
			WHERE mapped.source_kind = 'session_summaries'
			  AND source.session_id NOT IN (SELECT session_id FROM active_sessions)
		)
		SELECT COUNT(*) AS count FROM staged
	`);
	const remainingSourceRowCount = Math.max(
		0,
		eligibleSourceRowCount - stagedEligibleSourceRowCount,
	);
	return Object.freeze({
		batchSize,
		scannedSourceRowCount: sourceRowCount,
		eligibleSourceRowCount,
		plannedBatchCount: completedBatchCount + Math.ceil(remainingSourceRowCount / batchSize),
		completedBatchCount,
		stagedSourceRowCount,
		remainingSourceRowCount,
	});
}

function activeSessionCount(database: Database.Database): number {
	return count(database, `
		SELECT COUNT(*) AS count FROM (
			SELECT session_id FROM runtime_turns WHERE status = 'in_progress'
			UNION
			SELECT session_id FROM session_state
			WHERE state_key IN ('pending_decision', 'suspended_turn', 'node_effect_checkpoint')
		)
	`);
}

function excludedActiveRows(
	database: Database.Database,
	definition: (typeof SOURCE_TABLES)[number],
): CountAndBytesRow {
	return database.prepare(`
		SELECT COUNT(*) AS row_count,
		       COALESCE(SUM(length(CAST(${definition.payloadColumn} AS BLOB))), 0) AS payload_bytes
		FROM ${definition.table}
		WHERE session_id IN (
			SELECT session_id FROM runtime_turns WHERE status = 'in_progress'
			UNION
			SELECT session_id FROM session_state
			WHERE state_key IN ('pending_decision', 'suspended_turn', 'node_effect_checkpoint')
		)
	`).get() as CountAndBytesRow;
}

function boundedBatchSize(value: number | undefined): number {
	const candidate = value ?? DEFAULT_BATCH_SIZE;
	if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > MAX_BATCH_SIZE) {
		throw new RangeError(`batchSize must be between 1 and ${MAX_BATCH_SIZE}`);
	}
	return candidate;
}

function count(database: Database.Database, sql: string): number {
	const row = database.prepare(sql).get() as { readonly count: unknown };
	return nonNegativeInteger(row.count);
}

function nonNegativeInteger(value: unknown): number {
	const candidate = Number(value);
	if (!Number.isSafeInteger(candidate) || candidate < 0) {
		throw new StorageFailure("v9 normalization metric is invalid");
	}
	return candidate;
}

function sum<Value>(
	values: readonly Value[],
	select: (value: Value) => number,
): number {
	return values.reduce((total, value) => total + select(value), 0);
}

function ratio(numerator: number, denominator: number): number {
	if (denominator <= 0) return 0;
	return Math.round((numerator / denominator) * 10_000) / 10_000;
}
