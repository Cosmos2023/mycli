import { open } from "node:fs/promises";
import type { CanonicalImage } from "@mycli/core";
import { LocalImageInputError, MAX_LOCAL_IMAGE_BYTES } from "./local-image-loader.ts";

const PROMPT_IMAGE_MAX_DIMENSION = 2_048;
const MAX_INPUT_PIXELS = 64_000_000;
const RASTER_FORMATS = new Set(["png", "jpeg", "gif", "webp"]);

export async function loadPromptImage(
	path: string,
	detail: "high" | "original",
	signal: AbortSignal,
): Promise<CanonicalImage> {
	signal.throwIfAborted();
	const data = await readBoundedImage(path, signal);
	try {
		// Optional native decoder binaries must not gate ordinary CLI startup.
		const { default: sharp } = await import("sharp");
		signal.throwIfAborted();
		const image = sharp(data, { failOn: "warning", limitInputPixels: MAX_INPUT_PIXELS });
		const metadata = await image.metadata();
		if (!metadata.format || !RASTER_FORMATS.has(metadata.format)) {
			throw new LocalImageInputError("image attachment has an unsupported file type");
		}
		// Metadata alone does not detect corrupt or truncated pixel data.
		await image.clone().stats();
		signal.throwIfAborted();
		const resize = detail === "high"
			&& (metadata.width > PROMPT_IMAGE_MAX_DIMENSION || metadata.height > PROMPT_IMAGE_MAX_DIMENSION);
		const preserve = metadata.format === "png" || metadata.format === "jpeg" || metadata.format === "webp";
		let output = data;
		let format = metadata.format;
		if (resize || !preserve) {
			let pipeline = image.keepExif();
			if (metadata.icc?.subarray(16, 20).toString("ascii") === "RGB ") pipeline = pipeline.keepIccProfile();
			if (resize) pipeline = pipeline.resize(PROMPT_IMAGE_MAX_DIMENSION, PROMPT_IMAGE_MAX_DIMENSION, {
				fit: "inside", withoutEnlargement: true, kernel: sharp.kernel.linear,
			});
			if (format === "jpeg") pipeline = pipeline.jpeg({ quality: 85 });
			else if (format === "webp") pipeline = pipeline.webp({ lossless: true });
			else { pipeline = pipeline.png(); format = "png"; }
			output = await pipeline.toBuffer();
		}
		signal.throwIfAborted();
		if (output.length > MAX_LOCAL_IMAGE_BYTES) {
			throw new LocalImageInputError("processed image exceeds the per-file size limit");
		}
		return Object.freeze({ mediaType: `image/${format}` as CanonicalImage["mediaType"],
			data: output.toString("base64"), detail });
	} catch (error) {
		if (signal.aborted) throw signal.reason;
		if (error instanceof LocalImageInputError) throw error;
		throw new LocalImageInputError("image attachment could not be decoded");
	}
}

async function readBoundedImage(path: string, signal: AbortSignal): Promise<Buffer> {
	const file = await open(path, "r");
	try {
		const before = await file.stat();
		if (!before.isFile() || before.size <= 0) throw new LocalImageInputError("image attachment is not a non-empty file");
		if (before.size > MAX_LOCAL_IMAGE_BYTES) throw new LocalImageInputError("image attachment exceeds the per-file size limit");
		const data = Buffer.alloc(before.size);
		let offset = 0;
		while (offset < data.length) {
			signal.throwIfAborted();
			const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
			if (bytesRead === 0) throw new LocalImageInputError("image attachment changed while being read");
			offset += bytesRead;
		}
		const after = await file.stat();
		if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
			throw new LocalImageInputError("image attachment changed while being read");
		}
		return data;
	} finally { await file.close(); }
}
