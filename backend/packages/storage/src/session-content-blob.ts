import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { StorageFailure } from "./session-store.ts";

export const SESSION_CONTENT_BLOB_MAX_RAW_BYTES = 32 * 1024 * 1024;
export const SESSION_CONTENT_BLOB_MIN_COMPRESSION_SAVINGS_BYTES = 64;
export const SESSION_CONTENT_BLOB_EXTERNALIZATION_THRESHOLD_BYTES = 1_024;

export type SessionContentBlobCodec = "identity-v1" | "deflate-raw-v1";

export interface EncodedSessionContentBlob {
	readonly blobId: string;
	readonly codec: SessionContentBlobCodec;
	readonly rawBytes: number;
	readonly storedBytes: number;
	readonly payload: Buffer;
}

export interface StoredSessionContentBlob {
	readonly blobId: string;
	readonly codec: string;
	readonly rawBytes: number;
	readonly storedBytes: number;
	readonly payload: Uint8Array;
}

const CONTENT_BLOB_ID = /^sha256:[a-f0-9]{64}$/u;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function encodeSessionContentBlob(
	value: string | Uint8Array,
): EncodedSessionContentBlob {
	const raw = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
	if (raw.byteLength > SESSION_CONTENT_BLOB_MAX_RAW_BYTES) {
		throw new StorageFailure("session content blob exceeds the raw byte limit", {
			raw_bytes: raw.byteLength,
			maximum_raw_bytes: SESSION_CONTENT_BLOB_MAX_RAW_BYTES,
		});
	}
	let compressed: Buffer;
	try {
		compressed = deflateRawSync(raw, { level: 6 });
	} catch {
		throw new StorageFailure("session content blob compression failed");
	}
	const useDeflate = raw.byteLength - compressed.byteLength
		>= SESSION_CONTENT_BLOB_MIN_COMPRESSION_SAVINGS_BYTES;
	const payload = useDeflate ? compressed : Buffer.from(raw);
	return Object.freeze({
		blobId: contentBlobId(raw),
		codec: useDeflate ? "deflate-raw-v1" : "identity-v1",
		rawBytes: raw.byteLength,
		storedBytes: payload.byteLength,
		payload,
	});
}

export function decodeSessionContentBlob(blob: StoredSessionContentBlob): Buffer {
	const { blobId, codec, rawBytes, storedBytes } = blob;
	if (!CONTENT_BLOB_ID.test(blobId)) invalidBlob("identity");
	if (!Number.isSafeInteger(rawBytes) || rawBytes < 0
		|| rawBytes > SESSION_CONTENT_BLOB_MAX_RAW_BYTES) invalidBlob("raw_size");
	if (!Number.isSafeInteger(storedBytes) || storedBytes < 0) invalidBlob("stored_size");
	const payload = Buffer.from(blob.payload);
	if (payload.byteLength !== storedBytes) invalidBlob("stored_size");

	let raw: Buffer;
	if (codec === "identity-v1") {
		raw = payload;
	} else if (codec === "deflate-raw-v1") {
		try {
			raw = inflateRawSync(payload, { maxOutputLength: rawBytes + 1 });
		} catch {
			invalidBlob("compressed_payload");
		}
	} else {
		invalidBlob("codec");
	}
	if (raw.byteLength !== rawBytes) invalidBlob("raw_size");
	if (contentBlobId(raw) !== blobId) invalidBlob("digest");
	return raw;
}

export function decodeSessionContentBlobUtf8(blob: StoredSessionContentBlob): string {
	const raw = decodeSessionContentBlob(blob);
	try {
		return UTF8_DECODER.decode(raw);
	} catch {
		throw new StorageFailure("session content blob contains invalid UTF-8", {
			blob_error: "utf8",
		});
	}
}

export function contentBlobId(value: Uint8Array): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function invalidBlob(reason: string): never {
	throw new StorageFailure("session content blob is invalid", { blob_error: reason });
}
