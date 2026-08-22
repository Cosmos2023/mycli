import { statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { encodeSessionContentBlob, type EncodedSessionContentBlob } from "./session-content-blob.ts";
import { StorageFailure } from "./session-store.ts";
import { stableJson } from "./stable-json.ts";
import { externalizeTranscriptPayload } from "./transcript-payload-blobs.ts";
import type { TranscriptJsonValue } from "./transcript-events.ts";

const SQLITE_STAGING_OVERHEAD_RATIO = 1.2;
const MIGRATION_WAL_MINIMUM_BYTES = 64 * 1024 * 1024;
const MIGRATION_SAFETY_BYTES = 16 * 1024 * 1024;
const REFERENCE_FIXED_OVERHEAD_BYTES = 32;

export type V10ContentBlobSourceName = "transcript_events" | "model_input_blobs";

export interface V10ContentBlobSourceAnalysis {
	readonly source: V10ContentBlobSourceName;
	readonly rowCount: number;
	readonly inlinePayloadBytes: number;
	readonly eligibleValueCount: number;
	readonly eligibleReferenceBytes: number;
	readonly uniqueBlobCount: number;
	readonly uniqueRawBytes: number;
	readonly estimatedStoredBytes: number;
	readonly duplicateReferenceBytes: number;
	readonly estimatedRemainingInlineBytes: number;
	readonly estimatedReferenceBytes: number;
}

export interface V10ContentBlobMigrationHeadroom {
	readonly estimatedNormalizedPayloadBytes: number;
	readonly estimatedStagingBytes: number;
	readonly estimatedWalBytes: number;
	readonly safetyBytes: number;
	readonly reusableFreelistBytes: number;
	readonly requiredFreeBytes: number;
	readonly availableFreeBytes: number | null;
	readonly sufficientFreeSpace: boolean | null;
}

export interface V10ContentBlobAnalysis {
	readonly schemaVersion: 10;
	readonly databaseBytes: number;
	readonly sources: readonly V10ContentBlobSourceAnalysis[];
	readonly inlinePayloadBytes: number;
	readonly eligibleValueCount: number;
	readonly eligibleReferenceBytes: number;
	readonly uniqueBlobCount: number;
	readonly uniqueRawBytes: number;
	readonly estimatedStoredBytes: number;
	readonly compressionSavingsBytes: number;
	readonly duplicateReferenceBytes: number;
	readonly estimatedRemainingInlineBytes: number;
	readonly estimatedReferenceBytes: number;
	readonly invalidPayloadRowCount: number;
	readonly migrationHeadroom: V10ContentBlobMigrationHeadroom;
}

export interface AnalyzeV10ContentBlobsOptions {
	readonly dbPath: string;
	readonly externalizationThresholdBytes?: number;
}

interface PayloadRow {
	readonly payload_json: unknown;
}

interface MutableSourceAnalysis {
	rowCount: number;
	inlinePayloadBytes: number;
	eligibleValueCount: number;
	eligibleReferenceBytes: number;
	estimatedRemainingInlineBytes: number;
	estimatedReferenceBytes: number;
	readonly blobs: Map<string, EncodedSessionContentBlob>;
}

export function analyzeV10ContentBlobs(
	options: AnalyzeV10ContentBlobsOptions,
): V10ContentBlobAnalysis {
	let database: Database.Database;
	try {
		database = new Database(options.dbPath, { readonly: true, fileMustExist: true });
		database.pragma("query_only = ON");
	} catch {
		throw new StorageFailure("unable to open session storage for content-blob analysis");
	}
	try {
		assertSchemaV10(database);
		const transcript = emptySourceAnalysis();
		const modelInput = emptySourceAnalysis();
		const allBlobs = new Map<string, EncodedSessionContentBlob>();
		let invalidPayloadRowCount = 0;

		const transcriptRows = database.prepare(`
			SELECT payload_json FROM transcript_events ORDER BY sequence_no
		`).iterate() as IterableIterator<PayloadRow>;
		for (const row of transcriptRows) {
			transcript.rowCount += 1;
			if (typeof row.payload_json !== "string") {
				invalidPayloadRowCount += 1;
				continue;
			}
			transcript.inlinePayloadBytes += Buffer.byteLength(row.payload_json, "utf8");
			let parsed: TranscriptJsonValue;
			try {
				parsed = JSON.parse(row.payload_json) as TranscriptJsonValue;
			} catch {
				invalidPayloadRowCount += 1;
				continue;
			}
			try {
				const externalized = externalizeTranscriptPayload(parsed, {
					...(options.externalizationThresholdBytes === undefined
						? {}
						: { thresholdBytes: options.externalizationThresholdBytes }),
				});
				transcript.eligibleValueCount += externalized.references.length;
				transcript.eligibleReferenceBytes += externalized.references.reduce(
					(total, reference) => total + requiredBlob(externalized.blobs, reference.blobId).rawBytes,
					0,
				);
				transcript.estimatedRemainingInlineBytes += Buffer.byteLength(
					stableJson(externalized.storedValue),
					"utf8",
				);
				transcript.estimatedReferenceBytes += externalized.references.reduce(
					(total, reference) => total + REFERENCE_FIXED_OVERHEAD_BYTES
						+ Buffer.byteLength(reference.jsonPointer, "utf8")
						+ Buffer.byteLength(reference.blobId, "utf8"),
					0,
				);
				for (const blob of externalized.blobs) {
					addBlob(transcript.blobs, blob);
					addBlob(allBlobs, blob);
				}
			} catch (error) {
				if (error instanceof RangeError || error instanceof StorageFailure) throw error;
				invalidPayloadRowCount += 1;
			}
		}

		const modelInputRows = database.prepare(`
			SELECT payload_json FROM model_input_blobs ORDER BY blob_id
		`).iterate() as IterableIterator<PayloadRow>;
		for (const row of modelInputRows) {
			modelInput.rowCount += 1;
			if (typeof row.payload_json !== "string") {
				invalidPayloadRowCount += 1;
				continue;
			}
			const rawBytes = Buffer.byteLength(row.payload_json, "utf8");
			modelInput.inlinePayloadBytes += rawBytes;
			let blob: EncodedSessionContentBlob;
			try {
				JSON.parse(row.payload_json);
				blob = encodeSessionContentBlob(row.payload_json);
			} catch (error) {
				if (error instanceof StorageFailure) throw error;
				invalidPayloadRowCount += 1;
				continue;
			}
			modelInput.eligibleValueCount += 1;
			modelInput.eligibleReferenceBytes += rawBytes;
			modelInput.estimatedRemainingInlineBytes += Buffer.byteLength(
				stableJson({ contentBlobId: blob.blobId, schemaVersion: 1 }),
				"utf8",
			);
			modelInput.estimatedReferenceBytes += REFERENCE_FIXED_OVERHEAD_BYTES
				+ Buffer.byteLength(blob.blobId, "utf8") * 2;
			addBlob(modelInput.blobs, blob);
			addBlob(allBlobs, blob);
		}

		const sources = Object.freeze([
			sourceAnalysis("transcript_events", transcript),
			sourceAnalysis("model_input_blobs", modelInput),
		]);
		const inlinePayloadBytes = sum(sources, (source) => source.inlinePayloadBytes);
		const eligibleValueCount = sum(sources, (source) => source.eligibleValueCount);
		const eligibleReferenceBytes = sum(sources, (source) => source.eligibleReferenceBytes);
		const uniqueRawBytes = blobBytes(allBlobs, "rawBytes");
		const estimatedStoredBytes = blobBytes(allBlobs, "storedBytes");
		const estimatedRemainingInlineBytes = sum(
			sources,
			(source) => source.estimatedRemainingInlineBytes,
		);
		const estimatedReferenceBytes = sum(sources, (source) => source.estimatedReferenceBytes);
		const estimatedNormalizedPayloadBytes = estimatedStoredBytes
			+ estimatedRemainingInlineBytes + estimatedReferenceBytes;
		return Object.freeze({
			schemaVersion: 10,
			databaseBytes: statSync(options.dbPath).size,
			sources,
			inlinePayloadBytes,
			eligibleValueCount,
			eligibleReferenceBytes,
			uniqueBlobCount: allBlobs.size,
			uniqueRawBytes,
			estimatedStoredBytes,
			compressionSavingsBytes: Math.max(0, uniqueRawBytes - estimatedStoredBytes),
			duplicateReferenceBytes: Math.max(0, eligibleReferenceBytes - uniqueRawBytes),
			estimatedRemainingInlineBytes,
			estimatedReferenceBytes,
			invalidPayloadRowCount,
			migrationHeadroom: migrationHeadroom(
				database,
				options.dbPath,
				estimatedNormalizedPayloadBytes,
			),
		});
	} finally {
		database.close();
	}
}

function sourceAnalysis(
	source: V10ContentBlobSourceName,
	metrics: MutableSourceAnalysis,
): V10ContentBlobSourceAnalysis {
	const uniqueRawBytes = blobBytes(metrics.blobs, "rawBytes");
	const estimatedStoredBytes = blobBytes(metrics.blobs, "storedBytes");
	return Object.freeze({
		source,
		rowCount: metrics.rowCount,
		inlinePayloadBytes: metrics.inlinePayloadBytes,
		eligibleValueCount: metrics.eligibleValueCount,
		eligibleReferenceBytes: metrics.eligibleReferenceBytes,
		uniqueBlobCount: metrics.blobs.size,
		uniqueRawBytes,
		estimatedStoredBytes,
		duplicateReferenceBytes: Math.max(0, metrics.eligibleReferenceBytes - uniqueRawBytes),
		estimatedRemainingInlineBytes: metrics.estimatedRemainingInlineBytes,
		estimatedReferenceBytes: metrics.estimatedReferenceBytes,
	});
}

function migrationHeadroom(
	database: Database.Database,
	dbPath: string,
	estimatedNormalizedPayloadBytes: number,
): V10ContentBlobMigrationHeadroom {
	const pageSize = pragmaInteger(database, "page_size");
	const reusableFreelistBytes = pageSize * pragmaInteger(database, "freelist_count");
	const estimatedStagingBytes = Math.ceil(
		estimatedNormalizedPayloadBytes * SQLITE_STAGING_OVERHEAD_RATIO,
	);
	const estimatedWalBytes = Math.max(
		MIGRATION_WAL_MINIMUM_BYTES,
		Math.ceil(estimatedNormalizedPayloadBytes * 0.25),
	);
	const requiredFreeBytes = Math.max(
		0,
		estimatedStagingBytes + estimatedWalBytes + MIGRATION_SAFETY_BYTES
			- reusableFreelistBytes,
	);
	const availableFreeBytes = availableBytes(dbPath);
	return Object.freeze({
		estimatedNormalizedPayloadBytes,
		estimatedStagingBytes,
		estimatedWalBytes,
		safetyBytes: MIGRATION_SAFETY_BYTES,
		reusableFreelistBytes,
		requiredFreeBytes,
		availableFreeBytes,
		sufficientFreeSpace: availableFreeBytes === null ? null : availableFreeBytes >= requiredFreeBytes,
	});
}

function emptySourceAnalysis(): MutableSourceAnalysis {
	return {
		rowCount: 0,
		inlinePayloadBytes: 0,
		eligibleValueCount: 0,
		eligibleReferenceBytes: 0,
		estimatedRemainingInlineBytes: 0,
		estimatedReferenceBytes: 0,
		blobs: new Map<string, EncodedSessionContentBlob>(),
	};
}

function addBlob(
	blobs: Map<string, EncodedSessionContentBlob>,
	blob: EncodedSessionContentBlob,
): void {
	const existing = blobs.get(blob.blobId);
	if (existing && (existing.codec !== blob.codec || existing.rawBytes !== blob.rawBytes
		|| existing.storedBytes !== blob.storedBytes || !existing.payload.equals(blob.payload))) {
		throw new StorageFailure("session content blob hash collides with different content");
	}
	blobs.set(blob.blobId, existing ?? blob);
}

function requiredBlob(
	blobs: readonly EncodedSessionContentBlob[],
	blobId: string,
): EncodedSessionContentBlob {
	const blob = blobs.find((candidate) => candidate.blobId === blobId);
	if (!blob) throw new StorageFailure("content-blob analysis reference is incomplete");
	return blob;
}

function blobBytes(
	blobs: ReadonlyMap<string, EncodedSessionContentBlob>,
	field: "rawBytes" | "storedBytes",
): number {
	return [...blobs.values()].reduce((total, blob) => total + blob[field], 0);
}

function sum<Value>(
	values: readonly Value[],
	select: (value: Value) => number,
): number {
	return values.reduce((total, value) => total + select(value), 0);
}

function pragmaInteger(database: Database.Database, name: string): number {
	const value = database.pragma(name, { simple: true }) as unknown;
	if (!Number.isSafeInteger(value) || Number(value) < 0) {
		throw new StorageFailure("content-blob analysis SQLite metric is invalid");
	}
	return Number(value);
}

function availableBytes(dbPath: string): number | null {
	try {
		const stat = statfsSync(dirname(dbPath));
		return Number(stat.bavail) * Number(stat.bsize);
	} catch {
		return null;
	}
}

function assertSchemaV10(database: Database.Database): void {
	let value: unknown;
	try {
		value = database.prepare("SELECT version FROM schema_version").pluck().get();
	} catch {
		value = null;
	}
	if (value !== 10) {
		throw new StorageFailure("content-blob analysis requires schema version 10", {
			expected_version: 10,
			actual_version: typeof value === "number" && Number.isFinite(value) ? value : null,
		});
	}
}
