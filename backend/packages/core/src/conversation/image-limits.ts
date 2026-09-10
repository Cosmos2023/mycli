import type { CanonicalImage } from "../types.ts";

export const CANONICAL_IMAGE_MAX_COUNT = 16;
export const CANONICAL_IMAGE_DATA_MAX_CHARS = 20_000_000;

const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

export function normalizeCanonicalImages(value: unknown): readonly CanonicalImage[] {
	if (!Array.isArray(value) || value.length > CANONICAL_IMAGE_MAX_COUNT) {
		throw new TypeError("invalid canonical images");
	}
	let totalChars = 0;
	return Object.freeze(value.map((raw: unknown): CanonicalImage => {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			throw new TypeError("invalid canonical images");
		}
		const image = raw as Readonly<Record<string, unknown>>;
		if (typeof image.mediaType !== "string" || !IMAGE_MEDIA_TYPES.has(image.mediaType)
			|| typeof image.data !== "string" || image.data.length === 0
			|| image.data.length > CANONICAL_IMAGE_DATA_MAX_CHARS
			|| (totalChars += image.data.length) > CANONICAL_IMAGE_DATA_MAX_CHARS
			|| image.data.length % 4 !== 0 || !BASE64.test(image.data)
			|| (image.detail !== undefined && image.detail !== "high" && image.detail !== "original")) {
			throw new TypeError("invalid canonical images");
		}
		return Object.freeze({ mediaType: image.mediaType as CanonicalImage["mediaType"], data: image.data,
			...(image.detail === undefined ? {} : { detail: image.detail }) });
	}));
}
