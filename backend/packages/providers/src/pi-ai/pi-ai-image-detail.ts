import { canRequestOriginalImageDetail } from "@mycli/config";
import { normalizeCanonicalImages, type CanonicalImage, type ProviderRequest } from "@mycli/core";
import { ProviderFailure } from "../errors.ts";
import { imageDataUrl } from "./image-data-url.ts";
import type { PiAiApi } from "./pi-ai-model.ts";

export function piAiImageDetailTransform(
	request: ProviderRequest,
	api: PiAiApi,
): ((payload: unknown) => unknown) | undefined {
	if (api === "anthropic-messages") return undefined;
	const images = (request.items ?? []).flatMap((item) => item.type === "user" || item.type === "tool_result"
		? normalizeCanonicalImages(item.images ?? []) : []);
	if (!images.some((image) => image.detail !== undefined)) return undefined;
	const originalSupported = canRequestOriginalImageDetail(request);
	return (payload) => {
		if (!isRecord(payload)) throw invalidPayload();
		// Match occurrences as well as bytes: the same image can be viewed at two detail levels.
		const pending = new Map<string, Array<CanonicalImage["detail"]>>();
		for (const image of images) {
			const url = imageDataUrl(image);
			const values = pending.get(url) ?? [];
			values.push(image.detail === "original" && !originalSupported ? "high" : image.detail);
			pending.set(url, values);
		}
		const content = (value: unknown): unknown => {
			if (!Array.isArray(value)) return value;
			return value.map((block: unknown) => {
				if (!isRecord(block)) return block;
				if (block.type === "input_image" && typeof block.image_url === "string") {
					const detail = pending.get(block.image_url)?.shift();
					return detail === undefined ? block : { ...block, detail };
				}
				if (block.type === "image_url" && isRecord(block.image_url) && typeof block.image_url.url === "string") {
					const detail = pending.get(block.image_url.url)?.shift();
					return detail === undefined ? block : { ...block, image_url: { ...block.image_url, detail } };
				}
				return block;
			});
		};
		const field = api === "openai-completions" ? "messages" : "input";
		if (!Array.isArray(payload[field])) throw invalidPayload();
		return { ...payload, [field]: payload[field].map((item: unknown) => {
			if (!isRecord(item)) return item;
			return { ...item, ...(Array.isArray(item.content) ? { content: content(item.content) } : {}),
				...(Array.isArray(item.output) ? { output: content(item.output) } : {}) };
		}) };
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidPayload(): ProviderFailure {
	return new ProviderFailure({ code: "provider_error", message: "pi-ai generated an unexpected image payload shape" });
}
