import { CANONICAL_IMAGE_DATA_MAX_CHARS } from "@mycli/core";
import type { CanonicalImage } from "@mycli/core";
import { ProviderFailure } from "../errors.ts";

const IMAGE_MEDIA_TYPES = new Set<CanonicalImage["mediaType"]>([
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/webp",
]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

export function imageDataUrl(image: CanonicalImage): string {
	if (!IMAGE_MEDIA_TYPES.has(image.mediaType)
		|| !image.data
		|| image.data.length > CANONICAL_IMAGE_DATA_MAX_CHARS
		|| image.data.length % 4 !== 0
		|| !BASE64.test(image.data)) {
		throw new ProviderFailure({ code: "provider_error", message: "invalid provider image" });
	}
	return `data:${image.mediaType};base64,${image.data}`;
}
