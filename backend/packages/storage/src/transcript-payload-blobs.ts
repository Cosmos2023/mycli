import { StorageFailure } from "./session-store.ts";
import {
	decodeSessionContentBlobUtf8,
	encodeSessionContentBlob,
	SESSION_CONTENT_BLOB_EXTERNALIZATION_THRESHOLD_BYTES,
	SESSION_CONTENT_BLOB_MAX_RAW_BYTES,
	type EncodedSessionContentBlob,
	type StoredSessionContentBlob,
} from "./session-content-blob.ts";
import type { TranscriptJsonValue } from "./transcript-events.ts";

export interface TranscriptPayloadBlobReference {
	readonly jsonPointer: string;
	readonly blobId: string;
}

export interface ExternalizedTranscriptPayload {
	readonly storedValue: TranscriptJsonValue;
	readonly blobs: readonly EncodedSessionContentBlob[];
	readonly references: readonly TranscriptPayloadBlobReference[];
}

export interface ExternalizeTranscriptPayloadOptions {
	readonly thresholdBytes?: number;
}

export type LoadSessionContentBlob = (
	blobId: string,
) => StoredSessionContentBlob | undefined;

export interface HydrateTranscriptPayloadOptions {
	readonly cache?: Map<string, string>;
}

const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/u;
const MAX_JSON_POINTER_CHARS = 16_384;

export function externalizeTranscriptPayload(
	value: TranscriptJsonValue,
	options: ExternalizeTranscriptPayloadOptions = {},
): ExternalizedTranscriptPayload {
	const thresholdBytes = externalizationThreshold(options.thresholdBytes);
	const blobs = new Map<string, EncodedSessionContentBlob>();
	const references: TranscriptPayloadBlobReference[] = [];
	const storedValue = externalizeValue(value, "", thresholdBytes, blobs, references);
	return Object.freeze({
		storedValue,
		blobs: Object.freeze([...blobs.values()].sort((left, right) => (
			left.blobId.localeCompare(right.blobId)
		))),
		references: Object.freeze(references),
	});
}

export function hydrateTranscriptPayload(
	storedValue: TranscriptJsonValue,
	references: readonly TranscriptPayloadBlobReference[],
	loadBlob: LoadSessionContentBlob,
	options: HydrateTranscriptPayloadOptions = {},
): TranscriptJsonValue {
	const hydrated = mutableClone(storedValue);
	const paths = new Set<string>();
	const cache = options.cache ?? new Map<string, string>();
	for (const reference of [...references].sort((left, right) => (
		left.jsonPointer.localeCompare(right.jsonPointer)
	))) {
		const path = reference.jsonPointer;
		if (!path || path.length > MAX_JSON_POINTER_CHARS || paths.has(path)) {
			throw invalidReference("path");
		}
		paths.add(path);
		const segments = parseJsonPointer(path);
		if (segments.length === 0) throw invalidReference("path");
		const target = referenceTarget(hydrated, segments);
		if (target.value !== null) throw invalidReference("placeholder");
		let text = cache.get(reference.blobId);
		if (text === undefined) {
			const blob = loadBlob(reference.blobId);
			if (!blob) throw invalidReference("missing_blob");
			text = decodeSessionContentBlobUtf8(blob);
			cache.set(reference.blobId, text);
		}
		setReferenceTarget(target.container, target.key, text);
	}
	return freezeJson(hydrated);
}

function externalizeValue(
	value: TranscriptJsonValue,
	path: string,
	thresholdBytes: number,
	blobs: Map<string, EncodedSessionContentBlob>,
	references: TranscriptPayloadBlobReference[],
): TranscriptJsonValue {
	if (typeof value === "string") {
		if (Buffer.byteLength(value, "utf8") < thresholdBytes) return value;
		const blob = encodeSessionContentBlob(value);
		const existing = blobs.get(blob.blobId);
		if (existing && !sameEncodedBlob(existing, blob)) {
			throw new StorageFailure("session content blob hash collides with different content");
		}
		blobs.set(blob.blobId, existing ?? blob);
		references.push(Object.freeze({ jsonPointer: path, blobId: blob.blobId }));
		return null;
	}
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (Array.isArray(value)) {
		return Object.freeze(value.map((item, index) => externalizeValue(
			item,
			`${path}/${index}`,
			thresholdBytes,
			blobs,
			references,
		)));
	}
	if (!isRecord(value)) throw new StorageFailure("transcript payload contains invalid JSON");
	return Object.freeze(Object.fromEntries(Object.keys(value).sort().map((key) => [
		key,
		externalizeValue(
			value[key]!,
			`${path}/${escapeJsonPointerSegment(key)}`,
			thresholdBytes,
			blobs,
			references,
		),
	])));
}

function externalizationThreshold(value: number | undefined): number {
	const threshold = value ?? SESSION_CONTENT_BLOB_EXTERNALIZATION_THRESHOLD_BYTES;
	if (!Number.isSafeInteger(threshold) || threshold < 1
		|| threshold > SESSION_CONTENT_BLOB_MAX_RAW_BYTES) {
		throw new RangeError("content blob externalization threshold is invalid");
	}
	return threshold;
}

function escapeJsonPointerSegment(value: string): string {
	return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function parseJsonPointer(value: string): readonly string[] {
	if (!value.startsWith("/")) throw invalidReference("path");
	return Object.freeze(value.slice(1).split("/").map((segment) => {
		let decoded = "";
		for (let index = 0; index < segment.length; index += 1) {
			const character = segment[index]!;
			if (character !== "~") {
				decoded += character;
				continue;
			}
			const escape = segment[index + 1];
			if (escape === "0") decoded += "~";
			else if (escape === "1") decoded += "/";
			else throw invalidReference("path");
			index += 1;
		}
		return decoded;
	}));
}

function referenceTarget(
	root: MutableJsonValue,
	segments: readonly string[],
): Readonly<{ readonly container: MutableJsonContainer; readonly key: string | number; readonly value: MutableJsonValue }> {
	let current = root;
	for (const segment of segments.slice(0, -1)) {
		current = childValue(current, segment);
	}
	const finalSegment = segments.at(-1)!;
	if (Array.isArray(current)) {
		const index = arrayIndex(finalSegment, current.length);
		return { container: current, key: index, value: current[index]! };
	}
	if (!isMutableRecord(current) || !Object.hasOwn(current, finalSegment)) {
		throw invalidReference("path");
	}
	return { container: current, key: finalSegment, value: current[finalSegment]! };
}

function childValue(current: MutableJsonValue, segment: string): MutableJsonValue {
	if (Array.isArray(current)) return current[arrayIndex(segment, current.length)]!;
	if (!isMutableRecord(current) || !Object.hasOwn(current, segment)) {
		throw invalidReference("path");
	}
	const child = current[segment]!;
	if (child === null || typeof child !== "object") throw invalidReference("path");
	return child;
}

function arrayIndex(value: string, length: number): number {
	if (!ARRAY_INDEX.test(value)) throw invalidReference("path");
	const index = Number(value);
	if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
		throw invalidReference("path");
	}
	return index;
}

function setReferenceTarget(
	container: MutableJsonContainer,
	key: string | number,
	value: string,
): void {
	if (Array.isArray(container)) {
		container[key as number] = value;
		return;
	}
	Object.defineProperty(container, key, {
		configurable: true,
		enumerable: true,
		value,
		writable: true,
	});
}

function mutableClone(value: TranscriptJsonValue): MutableJsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "number"
		|| typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(mutableClone);
	if (isRecord(value)) return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, mutableClone(item)]),
	);
	throw new StorageFailure("transcript payload contains invalid JSON");
}

function freezeJson(value: MutableJsonValue): TranscriptJsonValue {
	if (Array.isArray(value)) return Object.freeze(value.map(freezeJson));
	if (isMutableRecord(value)) return Object.freeze(Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, freezeJson(item)]),
	));
	return value;
}

function sameEncodedBlob(
	left: EncodedSessionContentBlob,
	right: EncodedSessionContentBlob,
): boolean {
	return left.codec === right.codec && left.rawBytes === right.rawBytes
		&& left.storedBytes === right.storedBytes && left.payload.equals(right.payload);
}

function invalidReference(reason: string): StorageFailure {
	return new StorageFailure("transcript payload blob reference is invalid", {
		reference_error: reason,
	});
}

function isRecord(value: unknown): value is Readonly<Record<string, TranscriptJsonValue>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type MutableJsonValue = null | boolean | number | string | MutableJsonValue[] | MutableJsonObject;
type MutableJsonObject = { [key: string]: MutableJsonValue };
type MutableJsonContainer = MutableJsonValue[] | MutableJsonObject;

function isMutableRecord(value: MutableJsonValue): value is MutableJsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
