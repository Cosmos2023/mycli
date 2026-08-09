import {
	CANONICAL_IMAGE_DATA_MAX_CHARS,
	CANONICAL_IMAGE_MAX_COUNT,
} from "@mycli/core";
import type { CanonicalImage } from "@mycli/core";
import { StorageFailure } from "./session-store.ts";

const IMAGE_MEDIA_TYPES = new Set<CanonicalImage["mediaType"]>([
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/webp",
]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

export function canonicalImages(
	images: readonly CanonicalImage[],
	source: string,
): readonly CanonicalImage[] {
	if (!Array.isArray(images) || images.length > CANONICAL_IMAGE_MAX_COUNT) {
		throw invalidImages(source);
	}
	let totalChars = 0;
	return Object.freeze(images.map((image) => {
		if (!isRecord(image)
			|| !IMAGE_MEDIA_TYPES.has(image.mediaType as CanonicalImage["mediaType"])
			|| typeof image.data !== "string"
			|| !image.data
			|| image.data.length % 4 !== 0
			|| !BASE64.test(image.data)) {
			throw invalidImages(source);
		}
		totalChars += image.data.length;
		if (image.data.length > CANONICAL_IMAGE_DATA_MAX_CHARS
			|| totalChars > CANONICAL_IMAGE_DATA_MAX_CHARS) {
			throw invalidImages(source);
		}
		return Object.freeze({
			mediaType: image.mediaType as CanonicalImage["mediaType"],
			data: image.data,
		});
	}));
}

export function canonicalImageBlocks(value: unknown, source: string): readonly CanonicalImage[] {
	if (value === undefined || value === null) return Object.freeze([]);
	if (!Array.isArray(value)) throw invalidImages(source);
	const images = value.flatMap((raw): CanonicalImage[] => {
		if (!isRecord(raw) || raw.type !== "image") return [];
		return [{
			mediaType: raw.media_type as CanonicalImage["mediaType"],
			data: raw.data as string,
		}];
	});
	return canonicalImages(images, source);
}

export function imageBlocks(images: readonly CanonicalImage[]): readonly Readonly<Record<string, unknown>>[] {
	return canonicalImages(images, "canonical image blocks").map((image) => Object.freeze({
		type: "image",
		media_type: image.mediaType,
		data: image.data,
	}));
}

export function assertImagePathCount(
	imagePaths: readonly string[],
	images: readonly CanonicalImage[],
): void {
	if (!Array.isArray(imagePaths)
		|| imagePaths.some((path) => typeof path !== "string" || !path)
		|| imagePaths.length !== images.length) {
		throw new StorageFailure("image attachments do not match canonical image data");
	}
}

function invalidImages(source: string): StorageFailure {
	return new StorageFailure(`invalid canonical images in ${source}`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
