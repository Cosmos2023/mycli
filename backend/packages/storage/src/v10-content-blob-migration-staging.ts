import Database from "better-sqlite3";
import { modelInputBlob } from "./model-input-validation.ts";
import {
	encodeSessionContentBlob,
	type EncodedSessionContentBlob,
} from "./session-content-blob.ts";
import { StorageFailure } from "./session-store.ts";
import { stableJson } from "./stable-json.ts";
import { externalizeTranscriptPayload } from "./transcript-payload-blobs.ts";
import {
	parseTranscriptEventEnvelope,
	type TranscriptEventEnvelope,
	type TranscriptJsonValue,
} from "./transcript-events.ts";
import {
	v10ModelInputSourceHash,
	v10TranscriptSourceHash,
} from "./v10-content-blob-migration-source-hash.ts";

const DEFAULT_BATCH_SIZE = 250;
const MAX_BATCH_SIZE = 5_000;
const DEFAULT_MAX_BATCH_RAW_BYTES = 64 * 1024 * 1024;
const MAX_BATCH_RAW_BYTES = 512 * 1024 * 1024;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_BUSY_TIMEOUT_MS = 60_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export const V10_CONTENT_BLOB_MIGRATION_STAGING_VERSION = 1 as const;

export const V10_CONTENT_BLOB_MIGRATION_STAGING_TABLES = Object.freeze([
	"content_blob_migration_batches",
	"content_blob_migration_content",
	"content_blob_migration_event_source_map",
	"content_blob_migration_event_refs",
	"content_blob_migration_model_input_source_map",
	"content_blob_migration_source_conflicts",
]);

export const V10_CONTENT_BLOB_MIGRATION_STAGING_COLUMNS = Object.freeze({
	content_blob_migration_batches: Object.freeze([
		"batch_id", "started_at", "completed_at", "source_row_count",
		"transcript_event_count", "model_input_blob_count", "reference_count",
		"new_content_blob_count", "source_payload_bytes", "reference_raw_bytes",
		"new_raw_bytes", "new_stored_bytes", "first_source_kind",
		"first_source_identity", "last_source_kind", "last_source_identity",
		"schema_version_before", "schema_version_after", "staging_schema_version",
	]),
	content_blob_migration_content: Object.freeze([
		"blob_id", "codec", "raw_bytes", "stored_bytes", "payload_blob",
		"created_at", "staging_schema_version",
	]),
	content_blob_migration_event_source_map: Object.freeze([
		"sequence_no", "source_hash", "staged_payload_json", "source_payload_bytes",
		"staged_payload_bytes", "reference_count", "reference_raw_bytes", "batch_id",
		"mapped_at", "staging_schema_version",
	]),
	content_blob_migration_event_refs: Object.freeze([
		"sequence_no", "json_pointer", "blob_id", "staging_schema_version",
	]),
	content_blob_migration_model_input_source_map: Object.freeze([
		"blob_id", "source_hash", "content_blob_id", "source_payload_bytes",
		"content_stored_bytes", "batch_id", "mapped_at", "staging_schema_version",
	]),
	content_blob_migration_source_conflicts: Object.freeze([
		"source_kind", "source_identity", "detected_operation", "staging_schema_version",
	]),
} satisfies Readonly<Record<string, readonly string[]>>);

export const V10_CONTENT_BLOB_MIGRATION_DROP_STAGING_SQL = `
DROP TRIGGER IF EXISTS content_blob_migration_content_no_update;
DROP TRIGGER IF EXISTS content_blob_migration_transcript_update;
DROP TRIGGER IF EXISTS content_blob_migration_transcript_delete;
DROP TRIGGER IF EXISTS content_blob_migration_model_input_update;
DROP TRIGGER IF EXISTS content_blob_migration_model_input_delete;
DROP TABLE IF EXISTS content_blob_migration_source_conflicts;
DROP TABLE IF EXISTS content_blob_migration_event_refs;
DROP TABLE IF EXISTS content_blob_migration_model_input_source_map;
DROP TABLE IF EXISTS content_blob_migration_event_source_map;
DROP TABLE IF EXISTS content_blob_migration_content;
DROP TABLE IF EXISTS content_blob_migration_batches;
`;

export const V10_CONTENT_BLOB_MIGRATION_STAGING_SQL = `
CREATE TABLE IF NOT EXISTS content_blob_migration_batches (
    batch_id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    source_row_count INTEGER NOT NULL DEFAULT 0,
    transcript_event_count INTEGER NOT NULL DEFAULT 0,
    model_input_blob_count INTEGER NOT NULL DEFAULT 0,
    reference_count INTEGER NOT NULL DEFAULT 0,
    new_content_blob_count INTEGER NOT NULL DEFAULT 0,
    source_payload_bytes INTEGER NOT NULL DEFAULT 0,
    reference_raw_bytes INTEGER NOT NULL DEFAULT 0,
    new_raw_bytes INTEGER NOT NULL DEFAULT 0,
    new_stored_bytes INTEGER NOT NULL DEFAULT 0,
    first_source_kind TEXT,
    first_source_identity TEXT,
    last_source_kind TEXT,
    last_source_identity TEXT,
    schema_version_before INTEGER NOT NULL CHECK (schema_version_before = 10),
    schema_version_after INTEGER CHECK (schema_version_after = 10),
    staging_schema_version INTEGER NOT NULL DEFAULT 1
        CHECK (staging_schema_version = 1)
);

CREATE TABLE IF NOT EXISTS content_blob_migration_content (
    blob_id TEXT PRIMARY KEY CHECK (
        length(blob_id) = 71
        AND substr(blob_id, 1, 7) = 'sha256:'
        AND substr(blob_id, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    codec TEXT NOT NULL CHECK (codec IN ('identity-v1', 'deflate-raw-v1')),
    raw_bytes INTEGER NOT NULL CHECK (raw_bytes >= 0 AND raw_bytes <= 33554432),
    stored_bytes INTEGER NOT NULL CHECK (stored_bytes >= 0),
    payload_blob BLOB NOT NULL CHECK (length(payload_blob) = stored_bytes),
    created_at TEXT NOT NULL,
    staging_schema_version INTEGER NOT NULL DEFAULT 1
        CHECK (staging_schema_version = 1),
    CHECK (codec != 'identity-v1' OR raw_bytes = stored_bytes)
);

CREATE INDEX IF NOT EXISTS idx_content_blob_migration_content_codec
ON content_blob_migration_content(codec, raw_bytes);

CREATE TRIGGER IF NOT EXISTS content_blob_migration_content_no_update
BEFORE UPDATE ON content_blob_migration_content BEGIN
    SELECT RAISE(ABORT, 'content blob migration content is immutable');
END;

CREATE TABLE IF NOT EXISTS content_blob_migration_event_source_map (
    sequence_no INTEGER PRIMARY KEY,
    source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
    staged_payload_json TEXT NOT NULL CHECK (
        json_valid(staged_payload_json)
        AND COALESCE(json_extract(staged_payload_json, '$.schemaVersion') = 1, 0)
        AND COALESCE(json_type(staged_payload_json, '$.payload') = 'object', 0)
    ),
    source_payload_bytes INTEGER NOT NULL CHECK (source_payload_bytes >= 0),
    staged_payload_bytes INTEGER NOT NULL CHECK (staged_payload_bytes >= 0),
    reference_count INTEGER NOT NULL CHECK (reference_count >= 0),
    reference_raw_bytes INTEGER NOT NULL CHECK (reference_raw_bytes >= 0),
    batch_id INTEGER NOT NULL,
    mapped_at TEXT NOT NULL,
    staging_schema_version INTEGER NOT NULL DEFAULT 1
        CHECK (staging_schema_version = 1),
    FOREIGN KEY (batch_id) REFERENCES content_blob_migration_batches(batch_id)
);

CREATE INDEX IF NOT EXISTS idx_content_blob_migration_event_batch
ON content_blob_migration_event_source_map(batch_id, sequence_no);

CREATE TABLE IF NOT EXISTS content_blob_migration_event_refs (
    sequence_no INTEGER NOT NULL,
    json_pointer TEXT NOT NULL CHECK (
        length(json_pointer) BETWEEN 1 AND 16384
        AND substr(json_pointer, 1, 1) = '/'
    ),
    blob_id TEXT NOT NULL,
    staging_schema_version INTEGER NOT NULL DEFAULT 1
        CHECK (staging_schema_version = 1),
    PRIMARY KEY (sequence_no, json_pointer),
    FOREIGN KEY (sequence_no)
        REFERENCES content_blob_migration_event_source_map(sequence_no) ON DELETE CASCADE,
    FOREIGN KEY (blob_id)
        REFERENCES content_blob_migration_content(blob_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_content_blob_migration_event_refs_blob
ON content_blob_migration_event_refs(blob_id, sequence_no);

CREATE TABLE IF NOT EXISTS content_blob_migration_model_input_source_map (
    blob_id TEXT PRIMARY KEY,
    source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
    content_blob_id TEXT NOT NULL,
    source_payload_bytes INTEGER NOT NULL CHECK (source_payload_bytes >= 0),
    content_stored_bytes INTEGER NOT NULL CHECK (content_stored_bytes >= 0),
    batch_id INTEGER NOT NULL,
    mapped_at TEXT NOT NULL,
    staging_schema_version INTEGER NOT NULL DEFAULT 1
        CHECK (staging_schema_version = 1),
    FOREIGN KEY (content_blob_id)
        REFERENCES content_blob_migration_content(blob_id) ON DELETE RESTRICT,
    FOREIGN KEY (batch_id) REFERENCES content_blob_migration_batches(batch_id)
);

CREATE INDEX IF NOT EXISTS idx_content_blob_migration_model_input_content
ON content_blob_migration_model_input_source_map(content_blob_id, blob_id);

CREATE INDEX IF NOT EXISTS idx_content_blob_migration_model_input_batch
ON content_blob_migration_model_input_source_map(batch_id, blob_id);

CREATE TABLE IF NOT EXISTS content_blob_migration_source_conflicts (
    source_kind TEXT NOT NULL CHECK (source_kind IN ('transcript_event', 'model_input_blob')),
    source_identity TEXT NOT NULL,
    detected_operation TEXT NOT NULL CHECK (detected_operation IN ('update', 'delete')),
    staging_schema_version INTEGER NOT NULL DEFAULT 1
        CHECK (staging_schema_version = 1),
    PRIMARY KEY (source_kind, source_identity)
);

CREATE TRIGGER IF NOT EXISTS content_blob_migration_transcript_update
AFTER UPDATE ON transcript_events
WHEN EXISTS (
    SELECT 1 FROM content_blob_migration_event_source_map
    WHERE sequence_no = old.sequence_no
) BEGIN
    INSERT OR IGNORE INTO content_blob_migration_source_conflicts (
        source_kind, source_identity, detected_operation
    ) VALUES ('transcript_event', CAST(old.sequence_no AS TEXT), 'update');
END;

CREATE TRIGGER IF NOT EXISTS content_blob_migration_transcript_delete
AFTER DELETE ON transcript_events
WHEN EXISTS (
    SELECT 1 FROM content_blob_migration_event_source_map
    WHERE sequence_no = old.sequence_no
) BEGIN
    INSERT OR IGNORE INTO content_blob_migration_source_conflicts (
        source_kind, source_identity, detected_operation
    ) VALUES ('transcript_event', CAST(old.sequence_no AS TEXT), 'delete');
END;

CREATE TRIGGER IF NOT EXISTS content_blob_migration_model_input_update
AFTER UPDATE ON model_input_blobs
WHEN EXISTS (
    SELECT 1 FROM content_blob_migration_model_input_source_map
    WHERE blob_id = old.blob_id
) BEGIN
    INSERT OR IGNORE INTO content_blob_migration_source_conflicts (
        source_kind, source_identity, detected_operation
    ) VALUES ('model_input_blob', old.blob_id, 'update');
END;

CREATE TRIGGER IF NOT EXISTS content_blob_migration_model_input_delete
AFTER DELETE ON model_input_blobs
WHEN EXISTS (
    SELECT 1 FROM content_blob_migration_model_input_source_map
    WHERE blob_id = old.blob_id
) BEGIN
    INSERT OR IGNORE INTO content_blob_migration_source_conflicts (
        source_kind, source_identity, detected_operation
    ) VALUES ('model_input_blob', old.blob_id, 'delete');
END;
`;

export type V10ContentBlobMigrationStagingFailpoint =
	| "after_batch_created"
	| "after_source_staged";

export interface StageV10ContentBlobMigrationBatchOptions {
	readonly dbPath: string;
	readonly batchSize?: number;
	readonly maxBatchRawBytes?: number;
	readonly busyTimeoutMs?: number;
	readonly clock?: () => string;
	readonly failpoint?: (stage: V10ContentBlobMigrationStagingFailpoint) => void;
}

export interface ReconcileV10ContentBlobMigrationBatchOptions {
	readonly batchSize: number;
	readonly maxBatchRawBytes: number;
	readonly clock: () => string;
	readonly failpoint?: (stage: V10ContentBlobMigrationStagingFailpoint) => void;
}

export interface V10ContentBlobMigrationStagingBatchResult {
	readonly schemaVersion: 10;
	readonly targetSchemaVersion: 11;
	readonly stagingSchemaVersion: typeof V10_CONTENT_BLOB_MIGRATION_STAGING_VERSION;
	readonly batchId: number | null;
	readonly selectedSourceRowCount: number;
	readonly selectedTranscriptEventCount: number;
	readonly selectedModelInputBlobCount: number;
	readonly stagedReferenceCount: number;
	readonly newContentBlobCount: number;
	readonly newRawBytes: number;
	readonly newStoredBytes: number;
	readonly totalStagedSourceRowCount: number;
	readonly totalStagedTranscriptEventCount: number;
	readonly totalStagedModelInputBlobCount: number;
	readonly totalStagedReferenceCount: number;
	readonly totalStagedContentBlobCount: number;
	readonly completedBatchCount: number;
	readonly remainingSourceRowCount: number;
	readonly unresolvedSourceConflictCount: number;
	readonly complete: boolean;
}

export interface DiscardV10ContentBlobMigrationStagingOptions {
	readonly dbPath: string;
	readonly busyTimeoutMs?: number;
}

export interface V10ContentBlobMigrationStagingDiscardResult {
	readonly schemaVersion: 10;
	readonly stagingSchemaVersion: typeof V10_CONTENT_BLOB_MIGRATION_STAGING_VERSION;
	readonly discarded: boolean;
	readonly discardedBatchCount: number;
	readonly discardedSourceRowCount: number;
	readonly discardedReferenceCount: number;
	readonly discardedContentBlobCount: number;
}

type V10ContentBlobSourceKind = "transcript_event" | "model_input_blob";

interface SourcePointer {
	readonly sourceKind: V10ContentBlobSourceKind;
	readonly sourceIdentity: string;
}

interface TranscriptSourceRow {
	readonly sequence_no: unknown;
	readonly session_id: unknown;
	readonly event_id: unknown;
	readonly turn_id: unknown;
	readonly event_type: unknown;
	readonly provider_index: unknown;
	readonly model_visible: unknown;
	readonly payload_json: unknown;
	readonly created_at: unknown;
}

interface ModelInputSourceRow {
	readonly blob_id: unknown;
	readonly payload_json: unknown;
	readonly created_at: unknown;
}

interface LoadedTranscriptSource {
	readonly pointer: SourcePointer;
	readonly row: TranscriptSourceRow;
	readonly payloadJson: string;
	readonly sourceHash: string;
	readonly rawBytes: number;
	readonly event: TranscriptEventEnvelope;
}

interface LoadedModelInputSource {
	readonly pointer: SourcePointer;
	readonly row: ModelInputSourceRow;
	readonly blobId: string;
	readonly payloadJson: string;
	readonly sourceHash: string;
	readonly rawBytes: number;
}

type LoadedSource = LoadedTranscriptSource | LoadedModelInputSource;

interface BatchMetrics {
	selectedTranscriptEventCount: number;
	selectedModelInputBlobCount: number;
	stagedReferenceCount: number;
	newContentBlobCount: number;
	sourcePayloadBytes: number;
	referenceRawBytes: number;
	newRawBytes: number;
	newStoredBytes: number;
}

interface StoredContentRow {
	readonly codec: unknown;
	readonly raw_bytes: unknown;
	readonly stored_bytes: unknown;
	readonly payload_blob: unknown;
}

export function stageV10ContentBlobMigrationBatch(
	options: StageV10ContentBlobMigrationBatchOptions,
): V10ContentBlobMigrationStagingBatchResult {
	const batchSize = boundedInteger(
		options.batchSize ?? DEFAULT_BATCH_SIZE,
		1,
		MAX_BATCH_SIZE,
		"batchSize",
	);
	const maxBatchRawBytes = boundedInteger(
		options.maxBatchRawBytes ?? DEFAULT_MAX_BATCH_RAW_BYTES,
		1,
		MAX_BATCH_RAW_BYTES,
		"maxBatchRawBytes",
	);
	const busyTimeoutMs = boundedInteger(
		options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
		0,
		MAX_BUSY_TIMEOUT_MS,
		"busyTimeoutMs",
	);
	let database: Database.Database;
	try {
		database = new Database(options.dbPath, { fileMustExist: true });
		database.pragma("foreign_keys = ON");
		database.pragma(`busy_timeout = ${busyTimeoutMs}`);
	} catch (error) {
		throw stagingError(error, "unable to open session storage for content-blob staging");
	}

	try {
		database.exec("BEGIN IMMEDIATE");
		const result = reconcileV10ContentBlobMigrationBatchInTransaction(database, {
			batchSize,
			maxBatchRawBytes,
			clock: options.clock ?? utcTimestamp,
			...(options.failpoint ? { failpoint: options.failpoint } : {}),
		});
		database.exec("COMMIT");
		return result;
	} catch (error) {
		if (database.inTransaction) database.exec("ROLLBACK");
		throw stagingError(error, "v10 content-blob staging failed");
	} finally {
		database.close();
	}
}

export function reconcileV10ContentBlobMigrationBatchInTransaction(
	database: Database.Database,
	options: ReconcileV10ContentBlobMigrationBatchOptions,
): V10ContentBlobMigrationStagingBatchResult {
	if (!database.inTransaction) {
		throw new StorageFailure("content-blob staging reconciliation requires a transaction");
	}
	const batchSize = boundedInteger(options.batchSize, 1, MAX_BATCH_SIZE, "batchSize");
	const maxBatchRawBytes = boundedInteger(
		options.maxBatchRawBytes,
		1,
		MAX_BATCH_RAW_BYTES,
		"maxBatchRawBytes",
	);
	assertSchemaV10(database);
	assertNoPartialStagingTables(database);
	database.exec(V10_CONTENT_BLOB_MIGRATION_STAGING_SQL);
	assertStagingSchema(database);
	assertSourceConflictsResolved(database, batchSize);
	const sources = loadBoundedSources(database, batchSize, maxBatchRawBytes);
	if (sources.length === 0) return stagingResult(database, null, emptyBatchMetrics());

	const startedAt = timestamp(options.clock());
	const insertion = database.prepare(`
		INSERT INTO content_blob_migration_batches (
			started_at, schema_version_before, staging_schema_version
		) VALUES (?, 10, ?)
	`).run(startedAt, V10_CONTENT_BLOB_MIGRATION_STAGING_VERSION);
	const batchId = safeInteger(insertion.lastInsertRowid, "content-blob staging batch id");
	options.failpoint?.("after_batch_created");
	const metrics = emptyBatchMetrics();
	for (const source of sources) {
		if (source.pointer.sourceKind === "transcript_event") {
			stageTranscriptSource(database, source as LoadedTranscriptSource, batchId, startedAt, metrics);
		} else {
			stageModelInputSource(database, source as LoadedModelInputSource, batchId, startedAt, metrics);
		}
		metrics.sourcePayloadBytes += source.rawBytes;
		options.failpoint?.("after_source_staged");
	}
	const first = sources[0]!.pointer;
	const last = sources.at(-1)!.pointer;
	const completedAt = timestamp(options.clock());
	database.prepare(`
		UPDATE content_blob_migration_batches
		SET completed_at = ?, source_row_count = ?, transcript_event_count = ?,
		    model_input_blob_count = ?, reference_count = ?, new_content_blob_count = ?,
		    source_payload_bytes = ?, reference_raw_bytes = ?, new_raw_bytes = ?,
		    new_stored_bytes = ?, first_source_kind = ?, first_source_identity = ?,
		    last_source_kind = ?, last_source_identity = ?, schema_version_after = 10
		WHERE batch_id = ?
	`).run(
		completedAt,
		sources.length,
		metrics.selectedTranscriptEventCount,
		metrics.selectedModelInputBlobCount,
		metrics.stagedReferenceCount,
		metrics.newContentBlobCount,
		metrics.sourcePayloadBytes,
		metrics.referenceRawBytes,
		metrics.newRawBytes,
		metrics.newStoredBytes,
		first.sourceKind,
		first.sourceIdentity,
		last.sourceKind,
		last.sourceIdentity,
		batchId,
	);
	assertSchemaV10(database);
	return stagingResult(database, batchId, metrics);
}

export function discardV10ContentBlobMigrationStaging(
	options: DiscardV10ContentBlobMigrationStagingOptions,
): V10ContentBlobMigrationStagingDiscardResult {
	const busyTimeoutMs = boundedInteger(
		options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
		0,
		MAX_BUSY_TIMEOUT_MS,
		"busyTimeoutMs",
	);
	let database: Database.Database;
	try {
		database = new Database(options.dbPath, { fileMustExist: true });
		database.pragma("foreign_keys = ON");
		database.pragma(`busy_timeout = ${busyTimeoutMs}`);
	} catch (error) {
		throw stagingError(error, "unable to open session storage for content-blob staging cleanup");
	}
	try {
		database.exec("BEGIN IMMEDIATE");
		assertSchemaV10(database);
		const existingTables = existingStagingTables(database);
		const result = Object.freeze({
			schemaVersion: 10 as const,
			stagingSchemaVersion: V10_CONTENT_BLOB_MIGRATION_STAGING_VERSION,
			discarded: existingTables.size > 0,
			discardedBatchCount: optionalTableCount(database, "content_blob_migration_batches"),
			discardedSourceRowCount: optionalTableCount(
				database,
				"content_blob_migration_event_source_map",
			) + optionalTableCount(database, "content_blob_migration_model_input_source_map"),
			discardedReferenceCount: optionalTableCount(database, "content_blob_migration_event_refs")
				+ optionalTableCount(database, "content_blob_migration_model_input_source_map"),
			discardedContentBlobCount: optionalTableCount(
				database,
				"content_blob_migration_content",
			),
		});
		database.exec(V10_CONTENT_BLOB_MIGRATION_DROP_STAGING_SQL);
		database.exec("COMMIT");
		return result;
	} catch (error) {
		if (database.inTransaction) database.exec("ROLLBACK");
		throw stagingError(error, "v10 content-blob staging cleanup failed");
	} finally {
		database.close();
	}
}

function loadBoundedSources(
	database: Database.Database,
	batchSize: number,
	maxBatchRawBytes: number,
): readonly LoadedSource[] {
	const pointers = selectSourcePointers(database, batchSize);
	const sources: LoadedSource[] = [];
	let rawBytes = 0;
	for (const pointer of pointers) {
		const source = loadSource(database, pointer);
		if (sources.length > 0 && rawBytes + source.rawBytes > maxBatchRawBytes) break;
		sources.push(source);
		rawBytes += source.rawBytes;
	}
	return Object.freeze(sources);
}

function selectSourcePointers(
	database: Database.Database,
	batchSize: number,
): readonly SourcePointer[] {
	const eventRows = database.prepare(`
		SELECT events.sequence_no
		FROM transcript_events AS events
		LEFT JOIN content_blob_migration_event_source_map AS mapped
		  ON mapped.sequence_no = events.sequence_no
		WHERE mapped.sequence_no IS NULL
		ORDER BY events.sequence_no
		LIMIT ?
	`).all(batchSize) as readonly { readonly sequence_no: unknown }[];
	const pointers: SourcePointer[] = eventRows.map((row) => Object.freeze({
		sourceKind: "transcript_event" as const,
		sourceIdentity: String(safeInteger(row.sequence_no, "transcript event sequence")),
	}));
	const remaining = batchSize - pointers.length;
	if (remaining > 0) {
		const modelRows = database.prepare(`
			SELECT owner.blob_id
			FROM model_input_blobs AS owner
			LEFT JOIN content_blob_migration_model_input_source_map AS mapped
			  ON mapped.blob_id = owner.blob_id
			WHERE mapped.blob_id IS NULL
			ORDER BY owner.blob_id
			LIMIT ?
		`).all(remaining) as readonly { readonly blob_id: unknown }[];
		for (const row of modelRows) {
			pointers.push(Object.freeze({
				sourceKind: "model_input_blob" as const,
				sourceIdentity: nonEmptyString(row.blob_id, "model-input blob identity"),
			}));
		}
	}
	return Object.freeze(pointers);
}

function loadSource(database: Database.Database, pointer: SourcePointer): LoadedSource {
	return pointer.sourceKind === "transcript_event"
		? loadTranscriptSource(database, pointer)
		: loadModelInputSource(database, pointer);
}

function loadTranscriptSource(
	database: Database.Database,
	pointer: SourcePointer,
): LoadedTranscriptSource {
	const sequenceNo = safeInteger(pointer.sourceIdentity, "transcript event sequence");
	const row = database.prepare(`
		SELECT sequence_no, session_id, event_id, turn_id, event_type, provider_index,
		       model_visible, payload_json, created_at
		FROM transcript_events WHERE sequence_no = ?
	`).get(sequenceNo) as TranscriptSourceRow | undefined;
	if (!row || typeof row.payload_json !== "string") {
		throw new StorageFailure("content-blob staging transcript source is missing or invalid");
	}
	const event = transcriptEvent(row);
	return Object.freeze({
		pointer,
		row,
		payloadJson: row.payload_json,
		sourceHash: v10TranscriptSourceHash(row),
		rawBytes: Buffer.byteLength(row.payload_json, "utf8"),
		event,
	});
}

function loadModelInputSource(
	database: Database.Database,
	pointer: SourcePointer,
): LoadedModelInputSource {
	const row = database.prepare(`
		SELECT blob_id, payload_json, created_at FROM model_input_blobs WHERE blob_id = ?
	`).get(pointer.sourceIdentity) as ModelInputSourceRow | undefined;
	if (!row || typeof row.blob_id !== "string" || typeof row.payload_json !== "string"
		|| typeof row.created_at !== "string") {
		throw new StorageFailure("content-blob staging model-input source is missing or invalid");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(row.payload_json) as unknown;
	} catch {
		throw new StorageFailure("content-blob staging model-input source is invalid");
	}
	const canonical = modelInputBlob(parsed);
	if (canonical.id !== row.blob_id || canonical.json !== row.payload_json) {
		throw new StorageFailure("content-blob staging model-input source hash does not match");
	}
	return Object.freeze({
		pointer,
		row,
		blobId: row.blob_id,
		payloadJson: row.payload_json,
		sourceHash: v10ModelInputSourceHash(row),
		rawBytes: Buffer.byteLength(row.payload_json, "utf8"),
	});
}

function stageTranscriptSource(
	database: Database.Database,
	source: LoadedTranscriptSource,
	batchId: number,
	mappedAt: string,
	metrics: BatchMetrics,
): void {
	const canonical = Object.freeze({
		schemaVersion: source.event.schemaVersion,
		payload: source.event.payload,
	}) as unknown as TranscriptJsonValue;
	const externalized = externalizeTranscriptPayload(canonical);
	for (const blob of externalized.blobs) {
		if (stageContentBlob(database, blob, mappedAt)) addNewContentMetrics(metrics, blob);
	}
	const storedPayloadJson = stableJson(externalized.storedValue);
	const referenceRawBytes = externalized.references.reduce((total, reference) => (
		total + requiredEncodedBlob(externalized.blobs, reference.blobId).rawBytes
	), 0);
	database.prepare(`
		INSERT INTO content_blob_migration_event_source_map (
			sequence_no, source_hash, staged_payload_json, source_payload_bytes,
			staged_payload_bytes, reference_count, reference_raw_bytes,
			batch_id, mapped_at, staging_schema_version
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		safeInteger(source.row.sequence_no, "transcript event sequence"),
		source.sourceHash,
		storedPayloadJson,
		source.rawBytes,
		Buffer.byteLength(storedPayloadJson, "utf8"),
		externalized.references.length,
		referenceRawBytes,
		batchId,
		mappedAt,
		V10_CONTENT_BLOB_MIGRATION_STAGING_VERSION,
	);
	const insertReference = database.prepare(`
		INSERT INTO content_blob_migration_event_refs (
			sequence_no, json_pointer, blob_id, staging_schema_version
		) VALUES (?, ?, ?, ?)
	`);
	for (const reference of externalized.references) {
		insertReference.run(
			safeInteger(source.row.sequence_no, "transcript event sequence"),
			reference.jsonPointer,
			reference.blobId,
			V10_CONTENT_BLOB_MIGRATION_STAGING_VERSION,
		);
	}
	metrics.selectedTranscriptEventCount += 1;
	metrics.stagedReferenceCount += externalized.references.length;
	metrics.referenceRawBytes += referenceRawBytes;
}

function stageModelInputSource(
	database: Database.Database,
	source: LoadedModelInputSource,
	batchId: number,
	mappedAt: string,
	metrics: BatchMetrics,
): void {
	const content = encodeSessionContentBlob(source.payloadJson);
	if (stageContentBlob(database, content, mappedAt)) addNewContentMetrics(metrics, content);
	database.prepare(`
		INSERT INTO content_blob_migration_model_input_source_map (
			blob_id, source_hash, content_blob_id, source_payload_bytes,
			content_stored_bytes, batch_id, mapped_at, staging_schema_version
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		source.blobId,
		source.sourceHash,
		content.blobId,
		source.rawBytes,
		content.storedBytes,
		batchId,
		mappedAt,
		V10_CONTENT_BLOB_MIGRATION_STAGING_VERSION,
	);
	metrics.selectedModelInputBlobCount += 1;
	metrics.stagedReferenceCount += 1;
	metrics.referenceRawBytes += content.rawBytes;
}

function stageContentBlob(
	database: Database.Database,
	blob: EncodedSessionContentBlob,
	createdAt: string,
): boolean {
	const existing = database.prepare(`
		SELECT codec, raw_bytes, stored_bytes, payload_blob
		FROM content_blob_migration_content WHERE blob_id = ?
	`).get(blob.blobId) as StoredContentRow | undefined;
	if (existing) {
		if (existing.codec !== blob.codec || existing.raw_bytes !== blob.rawBytes
			|| existing.stored_bytes !== blob.storedBytes
			|| !Buffer.isBuffer(existing.payload_blob)
			|| !existing.payload_blob.equals(blob.payload)) {
			throw new StorageFailure("content-blob staging identity collides with different content");
		}
		return false;
	}
	database.prepare(`
		INSERT INTO content_blob_migration_content (
			blob_id, codec, raw_bytes, stored_bytes, payload_blob,
			created_at, staging_schema_version
		) VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run(
		blob.blobId,
		blob.codec,
		blob.rawBytes,
		blob.storedBytes,
		blob.payload,
		createdAt,
		V10_CONTENT_BLOB_MIGRATION_STAGING_VERSION,
	);
	return true;
}

function transcriptEvent(row: TranscriptSourceRow): TranscriptEventEnvelope {
	let stored: unknown;
	try {
		stored = JSON.parse(String(row.payload_json)) as unknown;
	} catch {
		throw new StorageFailure("content-blob staging transcript source is invalid");
	}
	if (!isRecord(stored)) {
		throw new StorageFailure("content-blob staging transcript source is invalid");
	}
	try {
		return parseTranscriptEventEnvelope({
			schemaVersion: stored.schemaVersion,
			sequenceNo: row.sequence_no,
			sessionId: row.session_id,
			eventId: row.event_id,
			...(typeof row.turn_id === "string" ? { turnId: row.turn_id } : {}),
			eventType: row.event_type,
			...(typeof row.provider_index === "number" ? { providerIndex: row.provider_index } : {}),
			modelVisible: row.model_visible === 1,
			createdAt: row.created_at,
			payload: stored.payload,
		});
	} catch {
		throw new StorageFailure("content-blob staging transcript source is invalid");
	}
}

function assertSourceConflictsResolved(database: Database.Database, limit: number): void {
	const conflicts = database.prepare(`
		SELECT source_kind, source_identity, detected_operation
		FROM content_blob_migration_source_conflicts
		ORDER BY CASE source_kind WHEN 'transcript_event' THEN 0 ELSE 1 END, source_identity
		LIMIT ?
	`).all(limit) as readonly {
		readonly source_kind: unknown;
		readonly source_identity: unknown;
		readonly detected_operation: unknown;
	}[];
	for (const conflict of conflicts) {
		const sourceKind = sourceKindValue(conflict.source_kind);
		const sourceIdentity = nonEmptyString(conflict.source_identity, "staged source identity");
		const expectedHash = mappedSourceHash(database, sourceKind, sourceIdentity);
		const currentHash = currentSourceHash(database, sourceKind, sourceIdentity);
		if (currentHash !== undefined && currentHash === expectedHash) {
			database.prepare(`
				DELETE FROM content_blob_migration_source_conflicts
				WHERE source_kind = ? AND source_identity = ?
			`).run(sourceKind, sourceIdentity);
			continue;
		}
		throw new StorageFailure("content-blob migration source changed after staging", {
			source_kind: sourceKind,
			source_operation: conflict.detected_operation === "delete" ? "delete" : "update",
		});
	}
}

function mappedSourceHash(
	database: Database.Database,
	sourceKind: V10ContentBlobSourceKind,
	sourceIdentity: string,
): string {
	const row = sourceKind === "transcript_event"
		? database.prepare(`
			SELECT source_hash FROM content_blob_migration_event_source_map WHERE sequence_no = ?
		`).get(safeInteger(sourceIdentity, "transcript event sequence")) as {
			readonly source_hash: unknown;
		} | undefined
		: database.prepare(`
			SELECT source_hash FROM content_blob_migration_model_input_source_map WHERE blob_id = ?
		`).get(sourceIdentity) as { readonly source_hash: unknown } | undefined;
	const hash = row?.source_hash;
	if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) {
		throw new StorageFailure("content-blob staging source map is invalid");
	}
	return hash;
}

function currentSourceHash(
	database: Database.Database,
	sourceKind: V10ContentBlobSourceKind,
	sourceIdentity: string,
): string | undefined {
	if (sourceKind === "transcript_event") {
		const row = database.prepare(`
			SELECT sequence_no, session_id, event_id, turn_id, event_type, provider_index,
			       model_visible, payload_json, created_at
			FROM transcript_events WHERE sequence_no = ?
		`).get(safeInteger(sourceIdentity, "transcript event sequence")) as TranscriptSourceRow | undefined;
		return row ? v10TranscriptSourceHash(row) : undefined;
	}
	const row = database.prepare(`
		SELECT blob_id, payload_json, created_at FROM model_input_blobs WHERE blob_id = ?
	`).get(sourceIdentity) as ModelInputSourceRow | undefined;
	return row ? v10ModelInputSourceHash(row) : undefined;
}

function stagingResult(
	database: Database.Database,
	batchId: number | null,
	metrics: BatchMetrics,
): V10ContentBlobMigrationStagingBatchResult {
	const totalStagedTranscriptEventCount = tableCount(
		database,
		"content_blob_migration_event_source_map",
	);
	const totalStagedModelInputBlobCount = tableCount(
		database,
		"content_blob_migration_model_input_source_map",
	);
	const remainingSourceRowCount = remainingSourceRows(database);
	const unresolvedSourceConflictCount = tableCount(
		database,
		"content_blob_migration_source_conflicts",
	);
	return Object.freeze({
		schemaVersion: 10 as const,
		targetSchemaVersion: 11 as const,
		stagingSchemaVersion: V10_CONTENT_BLOB_MIGRATION_STAGING_VERSION,
		batchId,
		selectedSourceRowCount: metrics.selectedTranscriptEventCount
			+ metrics.selectedModelInputBlobCount,
		selectedTranscriptEventCount: metrics.selectedTranscriptEventCount,
		selectedModelInputBlobCount: metrics.selectedModelInputBlobCount,
		stagedReferenceCount: metrics.stagedReferenceCount,
		newContentBlobCount: metrics.newContentBlobCount,
		newRawBytes: metrics.newRawBytes,
		newStoredBytes: metrics.newStoredBytes,
		totalStagedSourceRowCount: totalStagedTranscriptEventCount
			+ totalStagedModelInputBlobCount,
		totalStagedTranscriptEventCount,
		totalStagedModelInputBlobCount,
		totalStagedReferenceCount: tableCount(database, "content_blob_migration_event_refs")
			+ totalStagedModelInputBlobCount,
		totalStagedContentBlobCount: tableCount(database, "content_blob_migration_content"),
		completedBatchCount: tableCount(database, "content_blob_migration_batches"),
		remainingSourceRowCount,
		unresolvedSourceConflictCount,
		complete: remainingSourceRowCount === 0 && unresolvedSourceConflictCount === 0,
	});
}

function remainingSourceRows(database: Database.Database): number {
	const row = database.prepare(`
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
	`).get() as { readonly count: unknown };
	return nonNegativeInteger(row.count, "remaining content-blob source count");
}

function assertSchemaV10(database: Database.Database): void {
	let actual: unknown;
	try {
		actual = database.prepare("SELECT version FROM schema_version LIMIT 1").pluck().get();
	} catch {
		actual = null;
	}
	if (actual !== 10) {
		throw new StorageFailure("content-blob staging requires schema version 10", {
			expected_version: 10,
			actual_version: typeof actual === "number" && Number.isFinite(actual) ? actual : null,
		});
	}
}

function assertNoPartialStagingTables(database: Database.Database): void {
	const existing = existingStagingTables(database);
	if (existing.size !== 0
		&& existing.size !== V10_CONTENT_BLOB_MIGRATION_STAGING_TABLES.length) {
		throw new StorageFailure("content-blob migration staging schema is incomplete", {
			expected_table_count: V10_CONTENT_BLOB_MIGRATION_STAGING_TABLES.length,
			actual_table_count: existing.size,
		});
	}
}

function assertStagingSchema(database: Database.Database): void {
	for (const [table, columns] of Object.entries(V10_CONTENT_BLOB_MIGRATION_STAGING_COLUMNS)) {
		const actual = (database.prepare(`PRAGMA table_info(${table})`).all() as readonly {
			readonly name: unknown;
		}[]).map((row) => String(row.name));
		if (stableJson(actual) !== stableJson(columns)) {
			throw new StorageFailure("content-blob migration staging schema is incompatible");
		}
	}
}

function existingStagingTables(database: Database.Database): ReadonlySet<string> {
	const rows = database.prepare(`
		SELECT name FROM sqlite_master
		WHERE type = 'table' AND name IN (
			${V10_CONTENT_BLOB_MIGRATION_STAGING_TABLES.map(() => "?").join(", ")}
		)
	`).all(...V10_CONTENT_BLOB_MIGRATION_STAGING_TABLES) as readonly {
		readonly name: unknown;
	}[];
	return new Set(rows.map((row) => String(row.name)));
}

function optionalTableCount(database: Database.Database, table: string): number {
	if (!existingStagingTables(database).has(table)) return 0;
	return tableCount(database, table);
}

function tableCount(database: Database.Database, table: string): number {
	const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
		readonly count: unknown;
	};
	return nonNegativeInteger(row.count, `${table} count`);
}

function emptyBatchMetrics(): BatchMetrics {
	return {
		selectedTranscriptEventCount: 0,
		selectedModelInputBlobCount: 0,
		stagedReferenceCount: 0,
		newContentBlobCount: 0,
		sourcePayloadBytes: 0,
		referenceRawBytes: 0,
		newRawBytes: 0,
		newStoredBytes: 0,
	};
}

function addNewContentMetrics(metrics: BatchMetrics, blob: EncodedSessionContentBlob): void {
	metrics.newContentBlobCount += 1;
	metrics.newRawBytes += blob.rawBytes;
	metrics.newStoredBytes += blob.storedBytes;
}

function requiredEncodedBlob(
	blobs: readonly EncodedSessionContentBlob[],
	blobId: string,
): EncodedSessionContentBlob {
	const blob = blobs.find((candidate) => candidate.blobId === blobId);
	if (!blob) throw new StorageFailure("content-blob staging reference is incomplete");
	return blob;
}

function sourceKindValue(value: unknown): V10ContentBlobSourceKind {
	if (value === "transcript_event" || value === "model_input_blob") return value;
	throw new StorageFailure("content-blob staging source kind is invalid");
}

function timestamp(value: string): string {
	if (!value || !Number.isFinite(Date.parse(value))) {
		throw new StorageFailure("content-blob staging timestamp is invalid");
	}
	return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
	}
	return value;
}

function safeInteger(value: unknown, label: string): number {
	const candidate = Number(value);
	if (!Number.isSafeInteger(candidate) || candidate < 0) {
		throw new StorageFailure(`${label} is invalid`);
	}
	return candidate;
}

function nonNegativeInteger(value: unknown, label: string): number {
	const candidate = Number(value);
	if (!Number.isSafeInteger(candidate) || candidate < 0) {
		throw new StorageFailure(`${label} is invalid`);
	}
	return candidate;
}

function nonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value) throw new StorageFailure(`${label} is invalid`);
	return value;
}

function utcTimestamp(): string {
	return new Date().toISOString();
}

function stagingError(error: unknown, fallback: string): Error {
	if (error instanceof StorageFailure || error instanceof RangeError) return error;
	const code = sqliteCode(error);
	if (code?.startsWith("SQLITE_BUSY") || code?.startsWith("SQLITE_LOCKED")) {
		return new StorageFailure("database is busy", { sqlite_code: code });
	}
	return new StorageFailure(fallback, { ...(code ? { sqlite_code: code } : {}) });
}

function sqliteCode(error: unknown): string | undefined {
	if (!isRecord(error) || typeof error.code !== "string") return undefined;
	return error.code.slice(0, 64);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
