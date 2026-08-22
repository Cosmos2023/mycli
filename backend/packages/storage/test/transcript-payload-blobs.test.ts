import assert from "node:assert/strict";
import test from "node:test";
import {
	decodeSessionContentBlob,
	encodeSessionContentBlob,
	externalizeTranscriptPayload,
	hydrateTranscriptPayload,
	SESSION_CONTENT_BLOB_EXTERNALIZATION_THRESHOLD_BYTES,
	StorageFailure,
	type StoredSessionContentBlob,
	type TranscriptJsonValue,
} from "../src/index.ts";

test("externalizes strings deterministically with escaped RFC 6901 paths", () => {
	const repeated = "shared-large-value".repeat(100);
	const payload = {
		"a/b~c": repeated,
		nested: [repeated, "small"],
		marker: { $mycliContentBlob: "ordinary-semantic-data" },
	} satisfies TranscriptJsonValue;
	const result = externalizeTranscriptPayload(payload);

	assert.deepEqual(result.storedValue, {
		"a/b~c": null,
		marker: { $mycliContentBlob: "ordinary-semantic-data" },
		nested: [null, "small"],
	});
	assert.equal(result.blobs.length, 1);
	assert.deepEqual(result.references.map((reference) => reference.jsonPointer), [
		"/a~1b~0c",
		"/nested/0",
	]);
	assert.equal(result.references[0]?.blobId, result.references[1]?.blobId);
});

test("keeps below-threshold strings inline and externalizes the exact boundary", () => {
	const below = "x".repeat(SESSION_CONTENT_BLOB_EXTERNALIZATION_THRESHOLD_BYTES - 1);
	const boundary = "y".repeat(SESSION_CONTENT_BLOB_EXTERNALIZATION_THRESHOLD_BYTES);
	const result = externalizeTranscriptPayload({ below, boundary });

	assert.deepEqual(result.storedValue, { below, boundary: null });
	assert.equal(result.blobs.length, 1);
	assert.equal(result.references.length, 1);
});

test("hydrates exact stable JSON and caches repeated blob loads", () => {
	const repeated = "large\nvalue".repeat(200);
	const payload = {
		first: repeated,
		items: [{ text: repeated }, { text: "inline" }],
	} satisfies TranscriptJsonValue;
	const externalized = externalizeTranscriptPayload(payload);
	const blobs = new Map(externalized.blobs.map((blob) => [blob.blobId, blob]));
	let loads = 0;
	const hydrated = hydrateTranscriptPayload(
		externalized.storedValue,
		externalized.references,
		(blobId) => {
			loads += 1;
			return blobs.get(blobId);
		},
	);

	assert.deepEqual(hydrated, payload);
	assert.equal(JSON.stringify(hydrated), JSON.stringify(payload));
	assert.equal(loads, 1);
});

test("rejects duplicate, missing, malformed, conflicting, and non-placeholder paths", () => {
	const blob = encodeSessionContentBlob("x".repeat(2_000));
	const load = () => blob;
	const invalid = [
		[{ jsonPointer: "/value", blobId: blob.blobId }, { jsonPointer: "/value", blobId: blob.blobId }],
		[{ jsonPointer: "/missing", blobId: blob.blobId }],
		[{ jsonPointer: "/bad~2path", blobId: blob.blobId }],
		[{ jsonPointer: "/value/child", blobId: blob.blobId }],
	] as const;
	for (const references of invalid) {
		assert.throws(
			() => hydrateTranscriptPayload({ value: null }, references, load),
			(error: unknown) => error instanceof StorageFailure,
		);
	}
	assert.throws(
		() => hydrateTranscriptPayload({ value: "not-null" }, [
			{ jsonPointer: "/value", blobId: blob.blobId },
		], load),
		(error: unknown) => error instanceof StorageFailure
			&& error.diagnostics.reference_error === "placeholder",
	);
	assert.throws(
		() => hydrateTranscriptPayload({ value: null }, [
			{ jsonPointer: "/value", blobId: blob.blobId },
		], () => undefined),
		(error: unknown) => error instanceof StorageFailure
			&& error.diagnostics.reference_error === "missing_blob",
	);
});

test("rejects invalid UTF-8 referenced content", () => {
	const bytes = encodeSessionContentBlob(Uint8Array.from([0xff]));
	const stored: StoredSessionContentBlob = {
		...bytes,
		payload: decodeSessionContentBlob(bytes),
	};
	assert.throws(
		() => hydrateTranscriptPayload(
			{ value: null },
			[{ jsonPointer: "/value", blobId: bytes.blobId }],
			() => stored,
		),
		(error: unknown) => error instanceof StorageFailure
			&& error.diagnostics.blob_error === "utf8",
	);
});
