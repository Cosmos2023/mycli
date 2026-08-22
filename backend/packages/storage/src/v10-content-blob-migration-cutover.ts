import { createHash, type Hash } from "node:crypto";
import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
	MODEL_INPUT_CONTENT_BLOB_MARKER_JSON,
} from "./model-input-ledger.ts";
import { modelInputBlob } from "./model-input-validation.ts";
import {
	SCHEMA_V11_CONTENT_BLOB_SQL,
	SCHEMA_V11_CONTENTLESS_FTS_SQL,
	SCHEMA_V11_CONTENT_REFERENCE_SQL,
	SCHEMA_V11_VERSION,
} from "./schema.ts";
import {
	decodeSessionContentBlobUtf8,
	type StoredSessionContentBlob,
} from "./session-content-blob.ts";
import { StorageFailure } from "./session-store.ts";
import { stableJson } from "./stable-json.ts";
import {
	hydrateTranscriptPayload,
	type TranscriptPayloadBlobReference,
} from "./transcript-payload-blobs.ts";
import {
	parseTranscriptEventEnvelope,
	type TranscriptEventEnvelope,
	type TranscriptJsonValue,
} from "./transcript-events.ts";
import {
	reconcileV10ContentBlobMigrationBatchInTransaction,
	V10_CONTENT_BLOB_MIGRATION_DROP_STAGING_SQL,
	V10_CONTENT_BLOB_MIGRATION_STAGING_TABLES,
} from "./v10-content-blob-migration-staging.ts";
import {
	v10ModelInputSourceHash,
	v10TranscriptSourceHash,
} from "./v10-content-blob-migration-source-hash.ts";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const MAX_BUSY_TIMEOUT_MS = 60_000;
const DEFAULT_TAIL_BATCH_SIZE = 5_000;
const MAX_TAIL_BATCH_SIZE = 5_000;
const MAX_TAIL_RAW_BYTES = 512 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export const V10_CONTENT_BLOB_CUTOVER_MINIMUM_FREE_BYTES = 16 * 1024 * 1024;

export const V10_CONTENT_BLOB_CUTOVER_STAGES = Object.freeze([
	"after_tail_reconciliation",
	"after_source_validation",
	"after_pre_cutover_manifest",
	"after_content_install",
	"after_reference_install",
	"after_search_install",
	"after_payload_rewrite",
	"after_final_validation",
	"after_staging_cleanup",
	"before_version_marker",
	"after_version_marker",
] as const);

export type V10ContentBlobCutoverStage = typeof V10_CONTENT_BLOB_CUTOVER_STAGES[number];

export interface ApplyV10ContentBlobMigrationCutoverOptions {
	readonly dbPath: string;
	readonly busyTimeoutMs?: number;
	readonly tailBatchSize?: number;
	readonly clock?: () => string;
	readonly freeSpaceProbe?: (dbPath: string) => number;
	readonly failpoint?: (stage: V10ContentBlobCutoverStage) => void;
}

export interface V10ContentBlobMigrationCutoverResult {
	readonly schemaVersion: typeof SCHEMA_V11_VERSION;
	readonly tailSourceRowCount: number;
	readonly migratedTranscriptEventCount: number;
	readonly migratedModelInputBlobCount: number;
	readonly installedContentBlobCount: number;
	readonly installedReferenceCount: number;
	readonly indexedEventCount: number;
	readonly uniqueRawBytes: number;
	readonly storedBytes: number;
	readonly parityValidated: true;
	readonly stagingDiscarded: true;
}

interface TranscriptEventRow {
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

interface ModelInputRow {
	readonly blob_id: unknown;
	readonly payload_json: unknown;
	readonly created_at: unknown;
}

interface ContentBlobRow {
	readonly blob_id: unknown;
	readonly codec: unknown;
	readonly raw_bytes: unknown;
	readonly stored_bytes: unknown;
	readonly payload_blob: unknown;
}

interface ReferenceRow {
	readonly json_pointer: unknown;
	readonly blob_id: unknown;
}

interface StagingMetrics {
	readonly transcriptEventCount: number;
	readonly modelInputBlobCount: number;
	readonly contentBlobCount: number;
	readonly referenceCount: number;
	readonly uniqueRawBytes: number;
	readonly storedBytes: number;
}

interface CutoverManifest {
	readonly transcriptSha256: string;
	readonly providerProjectionSha256: string;
	readonly readableProjectionSha256: string;
	readonly searchSha256: string;
	readonly lineageSha256: string;
	readonly recoverySha256: string;
	readonly providerLedgerSha256: string;
}

type EventStorageMode = "inline" | "staging" | "final";
type ModelInputStorageMode = "inline" | "final";

export function applyV10ContentBlobMigrationCutover(
	options: ApplyV10ContentBlobMigrationCutoverOptions,
): V10ContentBlobMigrationCutoverResult {
	const busyTimeoutMs = boundedInteger(
		options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
		0,
		MAX_BUSY_TIMEOUT_MS,
		"busyTimeoutMs",
	);
	const tailBatchSize = boundedInteger(
		options.tailBatchSize ?? DEFAULT_TAIL_BATCH_SIZE,
		1,
		MAX_TAIL_BATCH_SIZE,
		"tailBatchSize",
	);
	assertFreeSpace(options.dbPath, options.freeSpaceProbe);
	let database: Database.Database;
	try {
		database = new Database(options.dbPath, { fileMustExist: true });
		database.pragma("foreign_keys = ON");
		database.pragma(`busy_timeout = ${busyTimeoutMs}`);
	} catch (error) {
		throw cutoverError(error, "unable to open session storage for content-blob cutover");
	}

	try {
		database.exec("BEGIN IMMEDIATE");
		assertSchemaV10(database);
		assertStagingExists(database);
		assertFinalObjectsAbsent(database);
		assertNoActiveWriters(database);
		const tail = reconcileV10ContentBlobMigrationBatchInTransaction(database, {
			batchSize: tailBatchSize,
			maxBatchRawBytes: MAX_TAIL_RAW_BYTES,
			clock: options.clock ?? utcTimestamp,
		});
		if (!tail.complete) {
			throw new StorageFailure("content-blob migration tail exceeds the final cutover bound", {
				remaining_source_rows: tail.remainingSourceRowCount,
				tail_batch_size: tailBatchSize,
			});
		}
		runFailpoint(options, "after_tail_reconciliation");

		const metrics = validateStaging(database);
		runFailpoint(options, "after_source_validation");
		const beforeManifest = createCutoverManifest(database, "inline", "inline");
		runFailpoint(options, "after_pre_cutover_manifest");

		installContent(database);
		runFailpoint(options, "after_content_install");
		installReferences(database);
		runFailpoint(options, "after_reference_install");
		installContentlessSearch(database);
		runFailpoint(options, "after_search_install");
		rewritePayloadRepresentations(database);
		runFailpoint(options, "after_payload_rewrite");

		validateFinalStorage(database, metrics);
		const afterManifest = createCutoverManifest(database, "final", "final");
		if (stableJson(afterManifest) !== stableJson(beforeManifest)) {
			throw new StorageFailure("content-blob cutover projection parity validation failed");
		}
		runFailpoint(options, "after_final_validation");

		database.exec(V10_CONTENT_BLOB_MIGRATION_DROP_STAGING_SQL);
		runFailpoint(options, "after_staging_cleanup");
		runFailpoint(options, "before_version_marker");
		database.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_V11_VERSION);
		runFailpoint(options, "after_version_marker");
		database.exec("COMMIT");
		return Object.freeze({
			schemaVersion: SCHEMA_V11_VERSION,
			tailSourceRowCount: tail.selectedSourceRowCount,
			migratedTranscriptEventCount: metrics.transcriptEventCount,
			migratedModelInputBlobCount: metrics.modelInputBlobCount,
			installedContentBlobCount: metrics.contentBlobCount,
			installedReferenceCount: metrics.referenceCount,
			indexedEventCount: indexedEventCount(database),
			uniqueRawBytes: metrics.uniqueRawBytes,
			storedBytes: metrics.storedBytes,
			parityValidated: true as const,
			stagingDiscarded: true as const,
		});
	} catch (error) {
		if (database.inTransaction) database.exec("ROLLBACK");
		throw cutoverError(error, "v10 content-blob cutover failed");
	} finally {
		database.close();
	}
}

function validateStaging(database: Database.Database): StagingMetrics {
	const incompleteBatchCount = count(database, `
		SELECT COUNT(*) AS count FROM content_blob_migration_batches
		WHERE completed_at IS NULL OR schema_version_after != 10
	`);
	const conflictCount = count(
		database,
		"SELECT COUNT(*) AS count FROM content_blob_migration_source_conflicts",
	);
	const missingEventMapCount = count(database, `
		SELECT COUNT(*) AS count FROM transcript_events AS events
		LEFT JOIN content_blob_migration_event_source_map AS mapped
		  ON mapped.sequence_no = events.sequence_no
		WHERE mapped.sequence_no IS NULL
	`);
	const extraEventMapCount = count(database, `
		SELECT COUNT(*) AS count FROM content_blob_migration_event_source_map AS mapped
		LEFT JOIN transcript_events AS events ON events.sequence_no = mapped.sequence_no
		WHERE events.sequence_no IS NULL
	`);
	const missingModelMapCount = count(database, `
		SELECT COUNT(*) AS count FROM model_input_blobs AS owner
		LEFT JOIN content_blob_migration_model_input_source_map AS mapped
		  ON mapped.blob_id = owner.blob_id
		WHERE mapped.blob_id IS NULL
	`);
	const extraModelMapCount = count(database, `
		SELECT COUNT(*) AS count FROM content_blob_migration_model_input_source_map AS mapped
		LEFT JOIN model_input_blobs AS owner ON owner.blob_id = mapped.blob_id
		WHERE owner.blob_id IS NULL
	`);
	if (incompleteBatchCount + conflictCount + missingEventMapCount + extraEventMapCount
		+ missingModelMapCount + extraModelMapCount > 0) {
		throw new StorageFailure("content-blob migration staging coverage is invalid", {
			incomplete_batch_count: incompleteBatchCount,
			source_conflict_count: conflictCount,
			missing_event_map_count: missingEventMapCount,
			extra_event_map_count: extraEventMapCount,
			missing_model_input_map_count: missingModelMapCount,
			extra_model_input_map_count: extraModelMapCount,
		});
	}

	validateStagedContent(database);
	validateStagedEvents(database);
	validateStagedModelInput(database);
	const orphanCount = count(database, `
		SELECT COUNT(*) AS count FROM content_blob_migration_content AS content
		WHERE NOT EXISTS (
			SELECT 1 FROM content_blob_migration_event_refs AS event_ref
			WHERE event_ref.blob_id = content.blob_id
		) AND NOT EXISTS (
			SELECT 1 FROM content_blob_migration_model_input_source_map AS model_ref
			WHERE model_ref.content_blob_id = content.blob_id
		)
	`);
	if (orphanCount > 0) {
		throw new StorageFailure("content-blob migration staging contains unreachable content", {
			orphan_content_count: orphanCount,
		});
	}
	const bytes = database.prepare(`
		SELECT COUNT(*) AS count, COALESCE(SUM(raw_bytes), 0) AS raw_bytes,
		       COALESCE(SUM(stored_bytes), 0) AS stored_bytes
		FROM content_blob_migration_content
	`).get() as {
		readonly count: unknown;
		readonly raw_bytes: unknown;
		readonly stored_bytes: unknown;
	};
	const transcriptEventCount = count(
		database,
		"SELECT COUNT(*) AS count FROM content_blob_migration_event_source_map",
	);
	const modelInputBlobCount = count(
		database,
		"SELECT COUNT(*) AS count FROM content_blob_migration_model_input_source_map",
	);
	return Object.freeze({
		transcriptEventCount,
		modelInputBlobCount,
		contentBlobCount: nonNegativeInteger(bytes.count, "staged content count"),
		referenceCount: count(database, "SELECT COUNT(*) AS count FROM content_blob_migration_event_refs")
			+ modelInputBlobCount,
		uniqueRawBytes: nonNegativeInteger(bytes.raw_bytes, "staged content raw bytes"),
		storedBytes: nonNegativeInteger(bytes.stored_bytes, "staged content stored bytes"),
	});
}

function validateStagedContent(database: Database.Database): void {
	const rows = database.prepare(`
		SELECT blob_id, codec, raw_bytes, stored_bytes, payload_blob
		FROM content_blob_migration_content ORDER BY blob_id
	`).iterate() as IterableIterator<ContentBlobRow>;
	for (const row of rows) decodeSessionContentBlobUtf8(storedContentBlob(row));
}

function validateStagedEvents(database: Database.Database): void {
	const rows = transcriptRows(database);
	for (const row of rows) {
		const inline = eventFromRow(row, parseStoredPayload(row.payload_json));
		const sourceHash = database.prepare(`
			SELECT source_hash FROM content_blob_migration_event_source_map WHERE sequence_no = ?
		`).pluck().get(row.sequence_no);
		if (sourceHash !== v10TranscriptSourceHash(row)) {
			throw new StorageFailure("content-blob migration transcript source hash changed");
		}
		const staged = loadStoredEventValue(database, row, "staging");
		const hydrated = hydrateEventValue(database, row, staged, "staging");
		const stagedEvent = eventFromRow(row, hydrated);
		if (stableJson(stagedEvent) !== stableJson(inline)) {
			throw new StorageFailure("content-blob migration transcript staging parity failed");
		}
		const mappedReferenceCount = database.prepare(`
			SELECT reference_count FROM content_blob_migration_event_source_map
			WHERE sequence_no = ?
		`).pluck().get(row.sequence_no);
		const actualReferenceCount = countFor(
			database,
			"SELECT COUNT(*) AS count FROM content_blob_migration_event_refs WHERE sequence_no = ?",
			row.sequence_no,
		);
		if (mappedReferenceCount !== actualReferenceCount) {
			throw new StorageFailure("content-blob migration event reference count is invalid");
		}
	}
}

function validateStagedModelInput(database: Database.Database): void {
	const rows = modelInputRows(database);
	for (const row of rows) {
		if (typeof row.blob_id !== "string" || typeof row.payload_json !== "string") {
			throw new StorageFailure("content-blob migration model-input source is invalid");
		}
		const mapped = database.prepare(`
			SELECT source_hash, content_blob_id
			FROM content_blob_migration_model_input_source_map WHERE blob_id = ?
		`).get(row.blob_id) as {
			readonly source_hash: unknown;
			readonly content_blob_id: unknown;
		} | undefined;
		if (!mapped || mapped.source_hash !== v10ModelInputSourceHash(row)
			|| typeof mapped.content_blob_id !== "string") {
			throw new StorageFailure("content-blob migration model-input source hash changed");
		}
		const hydrated = loadContentUtf8(database, "staging", mapped.content_blob_id);
		if (hydrated !== row.payload_json) {
			throw new StorageFailure("content-blob migration model-input staging parity failed");
		}
		assertModelInputIdentity(row.blob_id, hydrated);
	}
}

function installContent(database: Database.Database): void {
	database.exec(SCHEMA_V11_CONTENT_BLOB_SQL);
	database.exec(`
		INSERT INTO session_content_blobs (
			blob_id, codec, raw_bytes, stored_bytes, payload_blob, created_at
		)
		SELECT blob_id, codec, raw_bytes, stored_bytes, payload_blob, created_at
		FROM content_blob_migration_content ORDER BY blob_id
	`);
}

function installReferences(database: Database.Database): void {
	database.exec(SCHEMA_V11_CONTENT_REFERENCE_SQL);
	database.exec(`
		INSERT INTO transcript_event_blob_refs (sequence_no, json_pointer, blob_id)
		SELECT sequence_no, json_pointer, blob_id
		FROM content_blob_migration_event_refs ORDER BY sequence_no, json_pointer;

		INSERT INTO model_input_blob_refs (blob_id, content_blob_id)
		SELECT blob_id, content_blob_id
		FROM content_blob_migration_model_input_source_map ORDER BY blob_id;
	`);
}

function installContentlessSearch(database: Database.Database): void {
	database.exec(`
		DROP TRIGGER transcript_events_fts_insert;
		DROP TRIGGER transcript_events_fts_delete;
		DROP TRIGGER transcript_events_fts_update;
		DROP TABLE transcript_events_fts;
	`);
	database.exec(SCHEMA_V11_CONTENTLESS_FTS_SQL);
	database.exec(`
		INSERT INTO transcript_events_fts(rowid, payload_json)
		SELECT sequence_no, payload_json FROM transcript_events AS events
		WHERE ${SEARCHABLE_EVENT_SQL}
		ORDER BY sequence_no
	`);
}

function rewritePayloadRepresentations(database: Database.Database): void {
	database.exec("DROP TRIGGER transcript_events_no_update");
	database.exec(`
		UPDATE transcript_events
		SET payload_json = (
			SELECT staged.staged_payload_json
			FROM content_blob_migration_event_source_map AS staged
			WHERE staged.sequence_no = transcript_events.sequence_no
		)
	`);
	database.exec(`
		CREATE TRIGGER transcript_events_no_update
		BEFORE UPDATE ON transcript_events BEGIN
			SELECT RAISE(ABORT, 'transcript_events are append-only');
		END;
	`);
	database.exec("DROP TRIGGER model_input_blobs_no_update");
	database.prepare("UPDATE model_input_blobs SET payload_json = ?")
		.run(MODEL_INPUT_CONTENT_BLOB_MARKER_JSON);
	database.exec(`
		CREATE TRIGGER model_input_blobs_no_update
		BEFORE UPDATE ON model_input_blobs BEGIN
			SELECT RAISE(ABORT, 'model_input_blobs are immutable');
		END;
	`);
}

function validateFinalStorage(database: Database.Database, expected: StagingMetrics): void {
	const actual = Object.freeze({
		transcriptEventCount: count(database, "SELECT COUNT(*) AS count FROM transcript_events"),
		modelInputBlobCount: count(database, "SELECT COUNT(*) AS count FROM model_input_blobs"),
		contentBlobCount: count(database, "SELECT COUNT(*) AS count FROM session_content_blobs"),
		referenceCount: count(database, "SELECT COUNT(*) AS count FROM transcript_event_blob_refs")
			+ count(database, "SELECT COUNT(*) AS count FROM model_input_blob_refs"),
	});
	if (actual.transcriptEventCount !== expected.transcriptEventCount
		|| actual.modelInputBlobCount !== expected.modelInputBlobCount
		|| actual.contentBlobCount !== expected.contentBlobCount
		|| actual.referenceCount !== expected.referenceCount) {
		throw new StorageFailure("content-blob cutover installed row counts are invalid");
	}
	if (count(database, "SELECT COUNT(*) AS count FROM pragma_foreign_key_check") > 0) {
		throw new StorageFailure("content-blob cutover foreign-key validation failed");
	}
	for (const row of transcriptRows(database)) {
		eventFromRow(
			row,
			hydrateEventValue(database, row, loadStoredEventValue(database, row, "final"), "final"),
		);
	}
	for (const row of modelInputRows(database)) {
		if (typeof row.blob_id !== "string" || row.payload_json !== MODEL_INPUT_CONTENT_BLOB_MARKER_JSON) {
			throw new StorageFailure("content-blob cutover model-input marker is invalid");
		}
		const contentId = database.prepare(`
			SELECT content_blob_id FROM model_input_blob_refs WHERE blob_id = ?
		`).pluck().get(row.blob_id);
		if (typeof contentId !== "string") {
			throw new StorageFailure("content-blob cutover model-input reference is invalid");
		}
		assertModelInputIdentity(row.blob_id, loadContentUtf8(database, "final", contentId));
	}
	const invalidFtsRows = count(database, `
		SELECT COUNT(*) AS count FROM (
			SELECT sequence_no FROM (
				SELECT sequence_no FROM transcript_events AS events WHERE ${SEARCHABLE_EVENT_SQL}
				EXCEPT SELECT rowid FROM transcript_events_fts_docsize
			)
			UNION ALL
			SELECT rowid FROM (
				SELECT rowid FROM transcript_events_fts_docsize
				EXCEPT SELECT sequence_no FROM transcript_events AS events WHERE ${SEARCHABLE_EVENT_SQL}
			)
		)
	`);
	if (invalidFtsRows > 0) {
		throw new StorageFailure("content-blob cutover search row set is invalid", {
			invalid_fts_row_count: invalidFtsRows,
		});
	}
}

function createCutoverManifest(
	database: Database.Database,
	eventMode: EventStorageMode,
	modelInputMode: ModelInputStorageMode,
): CutoverManifest {
	const transcript = createHash("sha256");
	const provider = createHash("sha256");
	const readable = createHash("sha256");
	for (const row of transcriptRows(database)) {
		const stored = loadStoredEventValue(database, row, eventMode);
		const hydrated = eventMode === "inline"
			? stored
			: hydrateEventValue(database, row, stored, eventMode);
		const event = eventFromRow(row, hydrated);
		hashValue(transcript, event);
		if (event.modelVisible) hashValue(provider, event);
		if (readableEvent(event)) hashValue(readable, event);
	}
	const ledger = createHash("sha256");
	for (const row of modelInputRows(database)) {
		if (typeof row.blob_id !== "string" || typeof row.payload_json !== "string") {
			throw new StorageFailure("content-blob cutover model-input manifest row is invalid");
		}
		let payloadJson = row.payload_json;
		if (modelInputMode === "final") {
			const contentId = database.prepare(`
				SELECT content_blob_id FROM model_input_blob_refs WHERE blob_id = ?
			`).pluck().get(row.blob_id);
			if (typeof contentId !== "string") {
				throw new StorageFailure("content-blob cutover model-input manifest reference is invalid");
			}
			payloadJson = loadContentUtf8(database, "final", contentId);
		}
		assertModelInputIdentity(row.blob_id, payloadJson);
		hashValue(ledger, { blobId: row.blob_id, payloadJson });
	}
	for (const table of [
		"instruction_snapshots",
		"tool_set_snapshots",
		"model_context_events",
		"provider_input_timeline_events",
		"provider_request_manifests",
		"provider_step_events",
	]) hashTable(database, ledger, table);
	return Object.freeze({
		transcriptSha256: finishHash(transcript),
		providerProjectionSha256: finishHash(provider),
		readableProjectionSha256: finishHash(readable),
		searchSha256: ftsVocabularyHash(database),
		lineageSha256: tableGroupHash(database, ["conversation_trees"]),
		recoverySha256: tableGroupHash(database, ["runtime_turns", "session_state"]),
		providerLedgerSha256: finishHash(ledger),
	});
}

function loadStoredEventValue(
	database: Database.Database,
	row: TranscriptEventRow,
	mode: EventStorageMode,
): TranscriptJsonValue {
	if (mode === "inline") return parseStoredPayload(row.payload_json);
	const table = mode === "staging"
		? "content_blob_migration_event_source_map"
		: "transcript_events";
	const column = mode === "staging" ? "staged_payload_json" : "payload_json";
	const stored = database.prepare(`
		SELECT ${column} FROM ${table} WHERE sequence_no = ?
	`).pluck().get(row.sequence_no);
	return parseStoredPayload(stored);
}

function hydrateEventValue(
	database: Database.Database,
	row: TranscriptEventRow,
	stored: TranscriptJsonValue,
	mode: Exclude<EventStorageMode, "inline">,
): TranscriptJsonValue {
	const refsTable = mode === "staging"
		? "content_blob_migration_event_refs"
		: "transcript_event_blob_refs";
	const rows = database.prepare(`
		SELECT json_pointer, blob_id FROM ${refsTable}
		WHERE sequence_no = ? ORDER BY json_pointer
	`).all(row.sequence_no) as readonly ReferenceRow[];
	const references = rows.map((reference) => {
		if (typeof reference.json_pointer !== "string" || typeof reference.blob_id !== "string") {
			throw new StorageFailure("content-blob cutover transcript reference is invalid");
		}
		return Object.freeze({
			jsonPointer: reference.json_pointer,
			blobId: reference.blob_id,
		});
	}) satisfies readonly TranscriptPayloadBlobReference[];
	return hydrateTranscriptPayload(
		stored,
		references,
		(blobId) => loadContent(database, mode, blobId),
		{ cache: new Map<string, string>() },
	);
}

function loadContent(
	database: Database.Database,
	mode: "staging" | "final",
	blobId: string,
): StoredSessionContentBlob | undefined {
	const table = mode === "staging"
		? "content_blob_migration_content"
		: "session_content_blobs";
	const row = database.prepare(`
		SELECT blob_id, codec, raw_bytes, stored_bytes, payload_blob
		FROM ${table} WHERE blob_id = ?
	`).get(blobId) as ContentBlobRow | undefined;
	return row ? storedContentBlob(row) : undefined;
}

function loadContentUtf8(
	database: Database.Database,
	mode: "staging" | "final",
	blobId: string,
): string {
	const blob = loadContent(database, mode, blobId);
	if (!blob) throw new StorageFailure("content-blob cutover referenced content is missing");
	return decodeSessionContentBlobUtf8(blob);
}

function storedContentBlob(row: ContentBlobRow): StoredSessionContentBlob {
	if (typeof row.blob_id !== "string"
		|| (row.codec !== "identity-v1" && row.codec !== "deflate-raw-v1")
		|| !Number.isSafeInteger(row.raw_bytes) || !Number.isSafeInteger(row.stored_bytes)
		|| !Buffer.isBuffer(row.payload_blob)) {
		throw new StorageFailure("content-blob cutover stored content row is invalid");
	}
	return Object.freeze({
		blobId: row.blob_id,
		codec: row.codec,
		rawBytes: Number(row.raw_bytes),
		storedBytes: Number(row.stored_bytes),
		payload: row.payload_blob,
	});
}

function eventFromRow(
	row: TranscriptEventRow,
	stored: TranscriptJsonValue,
): TranscriptEventEnvelope {
	if (!isRecord(stored)) throw new StorageFailure("content-blob cutover event payload is invalid");
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
		throw new StorageFailure("content-blob cutover event payload is invalid");
	}
}

function parseStoredPayload(value: unknown): TranscriptJsonValue {
	try {
		const parsed = JSON.parse(String(value)) as unknown;
		if (!isRecord(parsed) || !("schemaVersion" in parsed) || !("payload" in parsed)) {
			throw new Error("invalid payload");
		}
		return parsed as TranscriptJsonValue;
	} catch {
		throw new StorageFailure("content-blob cutover stored event payload is invalid");
	}
}

function transcriptRows(database: Database.Database): readonly TranscriptEventRow[] {
	return database.prepare(`
		SELECT sequence_no, session_id, event_id, turn_id, event_type, provider_index,
		       model_visible, payload_json, created_at
		FROM transcript_events ORDER BY sequence_no
	`).all() as readonly TranscriptEventRow[];
}

function modelInputRows(database: Database.Database): readonly ModelInputRow[] {
	return database.prepare(`
		SELECT blob_id, payload_json, created_at FROM model_input_blobs ORDER BY blob_id
	`).all() as readonly ModelInputRow[];
}

function assertModelInputIdentity(blobId: string, payloadJson: string): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payloadJson) as unknown;
	} catch {
		throw new StorageFailure("content-blob cutover model-input content is invalid");
	}
	const canonical = modelInputBlob(parsed);
	if (canonical.id !== blobId || canonical.json !== payloadJson) {
		throw new StorageFailure("content-blob cutover model-input content hash does not match");
	}
}

function ftsVocabularyHash(database: Database.Database): string {
	database.exec("DROP TABLE IF EXISTS temp.content_blob_migration_fts_vocab");
	try {
		database.exec(`
			CREATE VIRTUAL TABLE temp.content_blob_migration_fts_vocab
			USING fts5vocab(main, transcript_events_fts, row)
		`);
		const hash = createHash("sha256");
		const rows = database.prepare(`
			SELECT term, doc, cnt FROM temp.content_blob_migration_fts_vocab ORDER BY term
		`).iterate() as IterableIterator<Readonly<Record<string, unknown>>>;
		for (const row of rows) hashValue(hash, row);
		return finishHash(hash);
	} finally {
		database.exec("DROP TABLE IF EXISTS temp.content_blob_migration_fts_vocab");
	}
}

function tableGroupHash(database: Database.Database, tables: readonly string[]): string {
	const hash = createHash("sha256");
	for (const table of tables) hashTable(database, hash, table);
	return finishHash(hash);
}

function hashTable(database: Database.Database, hash: Hash, table: string): void {
	hashValue(hash, { table });
	const rows = database.prepare(`SELECT * FROM ${table}`).all() as readonly Readonly<
		Record<string, unknown>
	>[];
	const stableRows = rows.map((row) => stableJson(row)).sort();
	for (const row of stableRows) hashText(hash, row);
}

function hashValue(hash: Hash, value: unknown): void {
	hashText(hash, stableJson(value));
}

function hashText(hash: Hash, value: string): void {
	const bytes = Buffer.byteLength(value, "utf8");
	hash.update(String(bytes));
	hash.update(":");
	hash.update(value);
	hash.update(";");
}

function finishHash(hash: Hash): string {
	const digest = hash.digest("hex");
	if (!HASH_PATTERN.test(digest)) throw new StorageFailure("content-blob cutover manifest is invalid");
	return digest;
}

function readableEvent(event: TranscriptEventEnvelope): boolean {
	return event.eventType !== "compaction" && event.eventType !== "rollback"
		&& !("readableProjection" in event.payload && event.payload.readableProjection?.hidden);
}

function indexedEventCount(database: Database.Database): number {
	return count(database, "SELECT COUNT(*) AS count FROM transcript_events_fts_docsize");
}

function assertStagingExists(database: Database.Database): void {
	const stagingTableCount = countFor(database, `
		SELECT COUNT(*) AS count FROM sqlite_master
		WHERE type = 'table' AND name IN (
			${V10_CONTENT_BLOB_MIGRATION_STAGING_TABLES.map(() => "?").join(", ")}
		)
	`, ...V10_CONTENT_BLOB_MIGRATION_STAGING_TABLES);
	if (stagingTableCount !== V10_CONTENT_BLOB_MIGRATION_STAGING_TABLES.length) {
		throw new StorageFailure("content-blob cutover requires complete staging", {
			expected_staging_table_count: V10_CONTENT_BLOB_MIGRATION_STAGING_TABLES.length,
			actual_staging_table_count: stagingTableCount,
		});
	}
}

function assertFinalObjectsAbsent(database: Database.Database): void {
	const count = countFor(database, `
		SELECT COUNT(*) AS count FROM sqlite_master
		WHERE name IN ('session_content_blobs', 'transcript_event_blob_refs', 'model_input_blob_refs')
	`);
	if (count > 0) {
		throw new StorageFailure("content-blob cutover found unexpected final storage objects", {
			unexpected_object_count: count,
		});
	}
}

function assertNoActiveWriters(database: Database.Database): void {
	const activeRuntimeTurnCount = count(database, `
		SELECT COUNT(*) AS count FROM runtime_turns WHERE status = 'in_progress'
	`);
	const activeRecoveryStateCount = count(database, `
		SELECT COUNT(*) AS count FROM session_state
		WHERE state_key IN ('pending_decision', 'suspended_turn', 'node_effect_checkpoint')
	`);
	if (activeRuntimeTurnCount + activeRecoveryStateCount > 0) {
		throw new StorageFailure("content-blob cutover is blocked by active session state", {
			active_runtime_turn_count: activeRuntimeTurnCount,
			active_recovery_state_count: activeRecoveryStateCount,
		});
	}
}

function assertSchemaV10(database: Database.Database): void {
	let actual: unknown;
	try {
		actual = database.prepare("SELECT version FROM schema_version LIMIT 1").pluck().get();
	} catch {
		actual = null;
	}
	if (actual !== 10) {
		throw new StorageFailure("content-blob cutover requires schema version 10", {
			expected_version: 10,
			actual_version: typeof actual === "number" && Number.isFinite(actual) ? actual : null,
		});
	}
}

function assertFreeSpace(
	dbPath: string,
	probe: ((dbPath: string) => number) | undefined,
): void {
	let available: number;
	try {
		if (probe) available = probe(dbPath);
		else {
			const fileSystem = statfsSync(dirname(dbPath));
			available = Math.min(
				Number.MAX_SAFE_INTEGER,
				Number(fileSystem.bavail) * Number(fileSystem.bsize),
			);
		}
	} catch {
		throw new StorageFailure("unable to determine content-blob cutover free space");
	}
	if (!Number.isSafeInteger(available) || available < 0) {
		throw new StorageFailure("content-blob cutover free space metric is invalid");
	}
	if (available < V10_CONTENT_BLOB_CUTOVER_MINIMUM_FREE_BYTES) {
		throw new StorageFailure("insufficient free space for content-blob cutover", {
			required_free_bytes: V10_CONTENT_BLOB_CUTOVER_MINIMUM_FREE_BYTES,
			available_free_bytes: available,
		});
	}
}

function runFailpoint(
	options: ApplyV10ContentBlobMigrationCutoverOptions,
	stage: V10ContentBlobCutoverStage,
): void {
	options.failpoint?.(stage);
}

function count(database: Database.Database, sql: string): number {
	return countFor(database, sql);
}

function countFor(database: Database.Database, sql: string, ...parameters: unknown[]): number {
	const row = database.prepare(sql).get(...parameters) as { readonly count: unknown };
	return nonNegativeInteger(row.count, "content-blob cutover count");
}

function nonNegativeInteger(value: unknown, label: string): number {
	const candidate = Number(value);
	if (!Number.isSafeInteger(candidate) || candidate < 0) {
		throw new StorageFailure(`${label} is invalid`);
	}
	return candidate;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
	}
	return value;
}

function utcTimestamp(): string {
	return new Date().toISOString();
}

function cutoverError(error: unknown, fallback: string): Error {
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

const SEARCHABLE_EVENT_SQL = `
events.model_visible = 1 AND (
    (events.event_type IN (
        'user_input', 'assistant_output', 'assistant_tool_call_batch', 'tool_result', 'context'
    ) AND COALESCE(
        json_extract(events.payload_json, '$.payload.readableProjection.searchVisible'), 1
    ) != 0)
    OR (events.event_type = 'opaque_legacy'
        AND json_extract(events.payload_json, '$.payload.sourceKind') = 'conversation_messages')
)
`;
