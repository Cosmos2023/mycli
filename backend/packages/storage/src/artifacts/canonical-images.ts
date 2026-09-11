import { normalizeCanonicalImages } from "@mycli/core";
import type { CanonicalImage } from "@mycli/core";
import { StorageFailure } from "../sessions/session-store.ts";

export function canonicalImages(
	images: readonly CanonicalImage[],
	source: string,
): readonly CanonicalImage[] {
	try {
		return normalizeCanonicalImages(images);
	} catch {
		throw invalidImages(source);
	}
}

export function canonicalImageBlocks(value: unknown, source: string): readonly CanonicalImage[] {
	if (value === undefined || value === null) return Object.freeze([]);
	if (!Array.isArray(value)) throw invalidImages(source);
	const images = value.flatMap((raw): CanonicalImage[] => {
		if (!isRecord(raw) || raw.type !== "image") return [];
		return [{
			mediaType: raw.media_type as CanonicalImage["mediaType"],
			data: raw.data as string,
			...(raw.detail === undefined ? {} : { detail: raw.detail as CanonicalImage["detail"] }),
		}];
	});
	return canonicalImages(images, source);
}

export function imageBlocks(images: readonly CanonicalImage[]): readonly Readonly<Record<string, unknown>>[] {
	return canonicalImages(images, "canonical image blocks").map((image) => Object.freeze({
		type: "image",
		media_type: image.mediaType,
		data: image.data,
		...(image.detail === undefined ? {} : { detail: image.detail }),
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
