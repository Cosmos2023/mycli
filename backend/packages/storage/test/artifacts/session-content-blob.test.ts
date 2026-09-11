import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
	decodeSessionContentBlob,
	decodeSessionContentBlobUtf8,
	encodeSessionContentBlob,
	SESSION_CONTENT_BLOB_MAX_RAW_BYTES,
	SESSION_CONTENT_BLOB_MIN_COMPRESSION_SAVINGS_BYTES,
	StorageFailure,
} from "../../src/index.ts";

test("encodes deterministic content identities and raw DEFLATE bytes", () => {
	const value = "compressible payload\n".repeat(2_000);
	const first = encodeSessionContentBlob(value);
	const second = encodeSessionContentBlob(value);

	assert.match(first.blobId, /^sha256:[a-f0-9]{64}$/u);
	assert.equal(first.codec, "deflate-raw-v1");
	assert.ok(first.rawBytes - first.storedBytes >= SESSION_CONTENT_BLOB_MIN_COMPRESSION_SAVINGS_BYTES);
	assert.deepEqual(first, second);
	assert.equal(decodeSessionContentBlobUtf8(first), value);
});

test("uses identity encoding when compression does not save enough bytes", () => {
	const value = randomBytes(2_048);
	const encoded = encodeSessionContentBlob(value);

	assert.equal(encoded.codec, "identity-v1");
	assert.equal(encoded.rawBytes, value.byteLength);
	assert.equal(encoded.storedBytes, value.byteLength);
	assert.deepEqual(decodeSessionContentBlob(encoded), value);
	assert.equal(encodeSessionContentBlob(new Uint8Array()).rawBytes, 0);
});

test("enforces the 32 MiB raw bound", () => {
	const boundary = Buffer.alloc(SESSION_CONTENT_BLOB_MAX_RAW_BYTES, 0x61);
	assert.equal(decodeSessionContentBlob(encodeSessionContentBlob(boundary)).byteLength, boundary.byteLength);
	assert.throws(
		() => encodeSessionContentBlob(Buffer.alloc(SESSION_CONTENT_BLOB_MAX_RAW_BYTES + 1)),
		(error: unknown) => error instanceof StorageFailure
			&& error.diagnostics.maximum_raw_bytes === SESSION_CONTENT_BLOB_MAX_RAW_BYTES,
	);
});

test("rejects unknown codecs, invalid sizes, truncation, and digest mismatches", () => {
	const encoded = encodeSessionContentBlob("repeat".repeat(1_000));
	const corruptions = [
		{ ...encoded, codec: "unknown-v1" },
		{ ...encoded, rawBytes: SESSION_CONTENT_BLOB_MAX_RAW_BYTES + 1 },
		{ ...encoded, rawBytes: 1 },
		{ ...encoded, storedBytes: encoded.storedBytes + 1 },
		{ ...encoded, payload: encoded.payload.subarray(0, encoded.payload.byteLength - 1), storedBytes: encoded.storedBytes - 1 },
		{ ...encoded, blobId: `sha256:${"0".repeat(64)}` },
	];
	for (const corruption of corruptions) {
		assert.throws(
			() => decodeSessionContentBlob(corruption),
			(error: unknown) => error instanceof StorageFailure
				&& !error.message.includes(encoded.blobId),
		);
	}
});

test("rejects invalid UTF-8 after byte integrity succeeds", () => {
	const encoded = encodeSessionContentBlob(Uint8Array.from([0xff, 0xfe]));
	assert.deepEqual(decodeSessionContentBlob(encoded), Buffer.from([0xff, 0xfe]));
	assert.throws(
		() => decodeSessionContentBlobUtf8(encoded),
		(error: unknown) => error instanceof StorageFailure
			&& error.diagnostics.blob_error === "utf8",
	);
});
