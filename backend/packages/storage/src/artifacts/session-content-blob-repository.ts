import type Database from "better-sqlite3";
import { StorageFailure } from "../sessions/session-store.ts";
import {
	decodeSessionContentBlob,
	decodeSessionContentBlobUtf8,
	encodeSessionContentBlob,
	type EncodedSessionContentBlob,
	type StoredSessionContentBlob,
} from "./session-content-blob.ts";
import type { TranscriptPayloadBlobReference } from "./transcript-payload-blobs.ts";
import type { SessionContentBlobMaintenanceMetrics } from "../sessions/session-store.ts";

export const SESSION_CONTENT_BLOB_LOAD_MANY_MAX_IDS = 4_096;

const CONTENT_BLOB_ID = /^sha256:[a-f0-9]{64}$/u;
const MODEL_INPUT_BLOB_ID_MAX_CHARS = 512;
const JSON_POINTER_MAX_CHARS = 16_384;
const SQLITE_PARAMETER_BATCH_SIZE = 500;

export type SessionContentBlobMetrics = SessionContentBlobMaintenanceMetrics;

export interface SessionContentBlobCollectionResult {
	readonly deletedBlobCount: number;
	readonly deletedRawBytes: number;
	readonly deletedStoredBytes: number;
}

export interface SessionContentBlobRepository {
	put(value: string | Uint8Array): EncodedSessionContentBlob;
	putEncoded(blob: EncodedSessionContentBlob): EncodedSessionContentBlob;
	loadBytes(blobId: string): Buffer | undefined;
	loadUtf8(blobId: string): string | undefined;
	loadMany(
		blobIds: readonly string[],
	): readonly (StoredSessionContentBlob | undefined)[];
	linkTranscriptEvent(
		sequenceNo: number,
		references: readonly TranscriptPayloadBlobReference[],
	): void;
	linkModelInputBlob(blobId: string, contentBlobId: string): void;
	metrics(): SessionContentBlobMetrics;
	collectOrphans(): SessionContentBlobCollectionResult;
}

export interface SQLiteSessionContentBlobRepositoryOptions {
	readonly database: Database.Database;
	readonly write: <Result>(operation: () => Result) => Result;
	readonly clock?: () => string;
}

interface ContentBlobRow {
	readonly blob_id: unknown;
	readonly codec: unknown;
	readonly raw_bytes: unknown;
	readonly stored_bytes: unknown;
	readonly payload_blob: unknown;
}

interface ContentBlobMetricsRow {
	readonly blob_count: unknown;
	readonly reference_count: unknown;
	readonly transcript_reference_count: unknown;
	readonly model_input_reference_count: unknown;
	readonly reachable_blob_count: unknown;
	readonly reachable_raw_bytes: unknown;
	readonly reachable_stored_bytes: unknown;
	readonly logical_reference_bytes: unknown;
	readonly orphan_blob_count: unknown;
	readonly orphan_raw_bytes: unknown;
	readonly orphan_stored_bytes: unknown;
}

interface OrphanMetricsRow {
	readonly blob_count: unknown;
	readonly raw_bytes: unknown;
	readonly stored_bytes: unknown;
}

export class SQLiteSessionContentBlobRepository implements SessionContentBlobRepository {
	readonly #database: Database.Database;
	readonly #writeTransaction: <Result>(operation: () => Result) => Result;
	readonly #clock: () => string;

	constructor(options: SQLiteSessionContentBlobRepositoryOptions) {
		this.#database = options.database;
		this.#writeTransaction = options.write;
		this.#clock = options.clock ?? utcTimestamp;
	}

	put(value: string | Uint8Array): EncodedSessionContentBlob {
		return this.putEncoded(encodeSessionContentBlob(value));
	}

	putEncoded(blob: EncodedSessionContentBlob): EncodedSessionContentBlob {
		return this.#write(() => {
			assertEncodedBlob(blob);
			this.#database.prepare(`
				INSERT INTO session_content_blobs (
					blob_id, codec, raw_bytes, stored_bytes, payload_blob, created_at
				) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(blob_id) DO NOTHING
			`).run(
				blob.blobId,
				blob.codec,
				blob.rawBytes,
				blob.storedBytes,
				blob.payload,
				this.#clock(),
			);
			const stored = this.#storedBlob(blob.blobId);
			if (!stored || !sameBlob(stored, blob)) {
				throw new StorageFailure(
					"session content blob identity collides with different content",
				);
			}
			return blob;
		});
	}

	loadBytes(blobId: string): Buffer | undefined {
		return this.#read(() => {
			const stored = this.#storedBlob(contentBlobId(blobId));
			return stored ? decodeSessionContentBlob(stored) : undefined;
		});
	}

	loadUtf8(blobId: string): string | undefined {
		return this.#read(() => {
			const stored = this.#storedBlob(contentBlobId(blobId));
			return stored ? decodeSessionContentBlobUtf8(stored) : undefined;
		});
	}

	loadMany(
		blobIds: readonly string[],
	): readonly (StoredSessionContentBlob | undefined)[] {
		return this.#read(() => {
			if (blobIds.length > SESSION_CONTENT_BLOB_LOAD_MANY_MAX_IDS) {
				throw new StorageFailure("too many session content blobs requested", {
					maximum_blob_count: SESSION_CONTENT_BLOB_LOAD_MANY_MAX_IDS,
				});
			}
			const normalized = blobIds.map(contentBlobId);
			const uniqueIds = [...new Set(normalized)];
			const loaded = new Map<string, StoredSessionContentBlob>();
			for (let offset = 0; offset < uniqueIds.length; offset += SQLITE_PARAMETER_BATCH_SIZE) {
				const batch = uniqueIds.slice(offset, offset + SQLITE_PARAMETER_BATCH_SIZE);
				if (batch.length === 0) continue;
				const placeholders = batch.map(() => "?").join(", ");
				const rows = this.#database.prepare(`
					SELECT blob_id, codec, raw_bytes, stored_bytes, payload_blob
					FROM session_content_blobs
					WHERE blob_id IN (${placeholders})
				`).all(...batch) as readonly ContentBlobRow[];
				for (const row of rows) {
					const stored = storedBlob(row);
					decodeSessionContentBlob(stored);
					loaded.set(stored.blobId, stored);
				}
			}
			return Object.freeze(normalized.map((blobId) => loaded.get(blobId)));
		});
	}

	linkTranscriptEvent(
		sequenceNo: number,
		references: readonly TranscriptPayloadBlobReference[],
	): void {
		this.#write(() => {
			if (!Number.isSafeInteger(sequenceNo) || sequenceNo <= 0) {
				throw new StorageFailure("transcript blob reference owner is invalid");
			}
			const paths = new Set<string>();
			for (const reference of references) {
				const jsonPointer = referencePath(reference.jsonPointer);
				const blobId = contentBlobId(reference.blobId);
				if (paths.has(jsonPointer)) {
					throw new StorageFailure("transcript blob reference path is duplicated");
				}
				paths.add(jsonPointer);
				this.#database.prepare(`
					INSERT INTO transcript_event_blob_refs (sequence_no, json_pointer, blob_id)
					VALUES (?, ?, ?)
					ON CONFLICT(sequence_no, json_pointer) DO NOTHING
				`).run(sequenceNo, jsonPointer, blobId);
				const stored = this.#database.prepare(`
					SELECT blob_id FROM transcript_event_blob_refs
					WHERE sequence_no = ? AND json_pointer = ?
				`).pluck().get(sequenceNo, jsonPointer);
				if (stored !== blobId) {
					throw new StorageFailure(
						"transcript blob reference conflicts with existing content",
					);
				}
			}
		});
	}

	linkModelInputBlob(blobId: string, contentBlobIdValue: string): void {
		this.#write(() => {
			const ownerId = modelInputBlobId(blobId);
			const contentId = contentBlobId(contentBlobIdValue);
			this.#database.prepare(`
				INSERT INTO model_input_blob_refs (blob_id, content_blob_id)
				VALUES (?, ?)
				ON CONFLICT(blob_id) DO NOTHING
			`).run(ownerId, contentId);
			const stored = this.#database.prepare(`
				SELECT content_blob_id FROM model_input_blob_refs WHERE blob_id = ?
			`).pluck().get(ownerId);
			if (stored !== contentId) {
				throw new StorageFailure(
					"model-input blob reference conflicts with existing content",
				);
			}
		});
	}

	metrics(): SessionContentBlobMetrics {
		return this.#read(() => {
			const row = this.#database.prepare(`
				WITH all_references(blob_id) AS (
					SELECT blob_id FROM transcript_event_blob_refs
					UNION ALL
					SELECT content_blob_id FROM model_input_blob_refs
				), reachable(blob_id) AS (
					SELECT DISTINCT blob_id FROM all_references
				)
				SELECT
					COUNT(*) AS blob_count,
					(SELECT COUNT(*) FROM all_references) AS reference_count,
					(SELECT COUNT(*) FROM transcript_event_blob_refs)
						AS transcript_reference_count,
					(SELECT COUNT(*) FROM model_input_blob_refs)
						AS model_input_reference_count,
					COALESCE(SUM(CASE WHEN reachable.blob_id IS NOT NULL THEN 1 ELSE 0 END), 0)
						AS reachable_blob_count,
					COALESCE(SUM(CASE WHEN reachable.blob_id IS NOT NULL THEN raw_bytes ELSE 0 END), 0)
						AS reachable_raw_bytes,
					COALESCE(SUM(CASE WHEN reachable.blob_id IS NOT NULL THEN stored_bytes ELSE 0 END), 0)
						AS reachable_stored_bytes,
					COALESCE((
						SELECT SUM(content.raw_bytes)
						FROM all_references AS reference
						JOIN session_content_blobs AS content ON content.blob_id = reference.blob_id
					), 0) AS logical_reference_bytes,
					COALESCE(SUM(CASE WHEN reachable.blob_id IS NULL THEN 1 ELSE 0 END), 0)
						AS orphan_blob_count,
					COALESCE(SUM(CASE WHEN reachable.blob_id IS NULL THEN raw_bytes ELSE 0 END), 0)
						AS orphan_raw_bytes,
					COALESCE(SUM(CASE WHEN reachable.blob_id IS NULL THEN stored_bytes ELSE 0 END), 0)
						AS orphan_stored_bytes
				FROM session_content_blobs AS content
				LEFT JOIN reachable ON reachable.blob_id = content.blob_id
			`).get() as ContentBlobMetricsRow;
			const reachableRawBytes = metric(row.reachable_raw_bytes);
			const logicalReferenceBytes = metric(row.logical_reference_bytes);
			return Object.freeze({
				blobCount: metric(row.blob_count),
				referenceCount: metric(row.reference_count),
				transcriptReferenceCount: metric(row.transcript_reference_count),
				modelInputReferenceCount: metric(row.model_input_reference_count),
				reachableBlobCount: metric(row.reachable_blob_count),
				reachableRawBytes,
				reachableStoredBytes: metric(row.reachable_stored_bytes),
				logicalReferenceBytes,
				deduplicatedReferenceBytes: logicalReferenceBytes - reachableRawBytes,
				orphanBlobCount: metric(row.orphan_blob_count),
				orphanRawBytes: metric(row.orphan_raw_bytes),
				orphanStoredBytes: metric(row.orphan_stored_bytes),
			});
		});
	}

	collectOrphans(): SessionContentBlobCollectionResult {
		return this.#write(() => {
			const where = `
				NOT EXISTS (
					SELECT 1 FROM transcript_event_blob_refs AS transcript
					WHERE transcript.blob_id = session_content_blobs.blob_id
				)
				AND NOT EXISTS (
					SELECT 1 FROM model_input_blob_refs AS model_input
					WHERE model_input.content_blob_id = session_content_blobs.blob_id
				)
			`;
			const row = this.#database.prepare(`
				SELECT COUNT(*) AS blob_count,
				       COALESCE(SUM(raw_bytes), 0) AS raw_bytes,
				       COALESCE(SUM(stored_bytes), 0) AS stored_bytes
				FROM session_content_blobs WHERE ${where}
			`).get() as OrphanMetricsRow;
			this.#database.prepare(`
				DELETE FROM session_content_blobs WHERE ${where}
			`).run();
			return Object.freeze({
				deletedBlobCount: metric(row.blob_count),
				deletedRawBytes: metric(row.raw_bytes),
				deletedStoredBytes: metric(row.stored_bytes),
			});
		});
	}

	#storedBlob(blobId: string): StoredSessionContentBlob | undefined {
		const row = this.#database.prepare(`
			SELECT blob_id, codec, raw_bytes, stored_bytes, payload_blob
			FROM session_content_blobs WHERE blob_id = ?
		`).get(blobId) as ContentBlobRow | undefined;
		return row ? storedBlob(row) : undefined;
	}

	#read<Result>(operation: () => Result): Result {
		try {
			return operation();
		} catch (error) {
			throw storageError(error);
		}
	}

	#write<Result>(operation: () => Result): Result {
		try {
			return this.#writeTransaction(operation);
		} catch (error) {
			throw storageError(error);
		}
	}
}

function assertEncodedBlob(blob: EncodedSessionContentBlob): void {
	contentBlobId(blob.blobId);
	decodeSessionContentBlob(blob);
}

function storedBlob(row: ContentBlobRow): StoredSessionContentBlob {
	if (typeof row.blob_id !== "string" || typeof row.codec !== "string"
		|| typeof row.raw_bytes !== "number" || typeof row.stored_bytes !== "number"
		|| !(row.payload_blob instanceof Uint8Array)) {
		throw new StorageFailure("session content blob row is invalid");
	}
	return Object.freeze({
		blobId: row.blob_id,
		codec: row.codec,
		rawBytes: row.raw_bytes,
		storedBytes: row.stored_bytes,
		payload: Buffer.from(row.payload_blob),
	});
}

function sameBlob(
	stored: StoredSessionContentBlob,
	encoded: EncodedSessionContentBlob,
): boolean {
	return stored.blobId === encoded.blobId && stored.codec === encoded.codec
		&& stored.rawBytes === encoded.rawBytes && stored.storedBytes === encoded.storedBytes
		&& Buffer.from(stored.payload).equals(encoded.payload);
}

function contentBlobId(value: unknown): string {
	if (typeof value !== "string" || !CONTENT_BLOB_ID.test(value)) {
		throw new StorageFailure("session content blob identity is invalid");
	}
	return value;
}

function modelInputBlobId(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > MODEL_INPUT_BLOB_ID_MAX_CHARS
		|| value.includes("\0")) {
		throw new StorageFailure("model-input blob identity is invalid");
	}
	return value;
}

function referencePath(value: unknown): string {
	if (typeof value !== "string" || !value.startsWith("/")
		|| value.length > JSON_POINTER_MAX_CHARS || value.includes("\0")) {
		throw new StorageFailure("transcript blob reference path is invalid");
	}
	return value;
}

function metric(value: unknown): number {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 0) {
		throw new StorageFailure("session content blob metrics are invalid");
	}
	return number;
}

function utcTimestamp(): string {
	return new Date().toISOString();
}

function storageError(error: unknown): Error {
	if (error instanceof StorageFailure || error instanceof RangeError) return error;
	const code = sqliteCode(error);
	return new StorageFailure("session content blob storage operation failed", {
		...(code ? { sqlite_code: code } : {}),
	});
}

function sqliteCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object" || !("code" in error)) return undefined;
	const code = Reflect.get(error, "code");
	return typeof code === "string" && code.length <= 64 ? code : undefined;
}
