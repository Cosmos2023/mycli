import { readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { CANONICAL_IMAGE_MAX_COUNT } from "@mycli/core";
import type { CanonicalImage } from "@mycli/core";

export const MAX_LOCAL_IMAGE_COUNT = CANONICAL_IMAGE_MAX_COUNT;
export const MAX_LOCAL_IMAGE_BYTES = 10_000_000;
export const MAX_LOCAL_IMAGE_TOTAL_BYTES = 15_000_000;

const MAX_IMAGE_PATH_CHARS = 4_096;
const MEDIA_TYPES = new Map<string, CanonicalImage["mediaType"]>([
	[".gif", "image/gif"],
	[".jpeg", "image/jpeg"],
	[".jpg", "image/jpeg"],
	[".png", "image/png"],
	[".webp", "image/webp"],
]);

export interface LoadLocalImagesOptions {
	readonly cwd: string;
	readonly homeDir: string;
	readonly maxCount?: number;
	readonly maxImageBytes?: number;
	readonly maxTotalBytes?: number;
}

export class LocalImageInputError extends Error {
	readonly code = "invalid_params" as const;
}

export function loadLocalImages(
	paths: readonly string[],
	options: LoadLocalImagesOptions,
): readonly CanonicalImage[] {
	const maxCount = positiveLimit(options.maxCount, MAX_LOCAL_IMAGE_COUNT, "image count limit");
	const maxImageBytes = positiveLimit(
		options.maxImageBytes,
		MAX_LOCAL_IMAGE_BYTES,
		"image size limit",
	);
	const maxTotalBytes = positiveLimit(
		options.maxTotalBytes,
		MAX_LOCAL_IMAGE_TOTAL_BYTES,
		"total image size limit",
	);
	if (paths.length > maxCount) {
		throw new LocalImageInputError(`image attachments exceed the limit of ${maxCount}`);
	}

	let totalBytes = 0;
	const images = paths.map((rawPath): CanonicalImage => {
		const path = localImagePath(rawPath, options);
		const mediaType = MEDIA_TYPES.get(extname(path).toLowerCase());
		if (!mediaType) throw new LocalImageInputError("image attachment has an unsupported file type");
		let size: number;
		try {
			const stat = statSync(path);
			if (!stat.isFile()) throw new LocalImageInputError("image attachment is not a file");
			size = stat.size;
		} catch (error) {
			if (error instanceof LocalImageInputError) throw error;
			throw new LocalImageInputError("image attachment is not a readable file");
		}
		if (size <= 0) throw new LocalImageInputError("image attachment is empty");
		if (size > maxImageBytes) {
			throw new LocalImageInputError("image attachment exceeds the per-file size limit");
		}
		totalBytes += size;
		if (totalBytes > maxTotalBytes) {
			throw new LocalImageInputError("image attachments exceed the total size limit");
		}
		try {
			const data = readFileSync(path);
			if (data.byteLength !== size) {
				throw new LocalImageInputError("image attachment changed while being read");
			}
			return Object.freeze({ mediaType, data: data.toString("base64") });
		} catch (error) {
			if (error instanceof LocalImageInputError) throw error;
			throw new LocalImageInputError("image attachment could not be read");
		}
	});
	return Object.freeze(images);
}

function localImagePath(rawPath: string, options: LoadLocalImagesOptions): string {
	if (!rawPath || rawPath.length > MAX_IMAGE_PATH_CHARS || rawPath.includes("\0")) {
		throw new LocalImageInputError("image attachment path is invalid");
	}
	if (rawPath.startsWith("~") && !rawPath.startsWith("~/") && !rawPath.startsWith("~\\")) {
		throw new LocalImageInputError("image attachment path is invalid");
	}
	const expanded = rawPath.startsWith("~/") || rawPath.startsWith("~\\")
		? join(options.homeDir, rawPath.slice(2))
		: rawPath;
	return resolve(options.cwd, expanded);
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved <= 0) {
		throw new RangeError(`${name} must be a positive safe integer`);
	}
	return resolved;
}
