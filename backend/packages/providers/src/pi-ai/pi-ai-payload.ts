import type { ProviderRequest } from "@mycli/core";
import { ProviderFailure } from "../errors.ts";
import type { PiAiApi } from "./pi-ai-model.ts";
import { piAiImageDetailTransform } from "./pi-ai-image-detail.ts";

const RESPONSES_WEB_SEARCH_TOOL = Object.freeze({
	type: "web_search",
	external_web_access: true,
});

export function piAiPayloadTransform(
	request: ProviderRequest,
	api: PiAiApi,
): ((payload: unknown) => unknown) | undefined {
	const imageDetails = piAiImageDetailTransform(request, api);
	if (request.webSearchMode !== "live") return imageDetails;
	if (api !== "openai-responses") {
		throw new ProviderFailure({
			code: "unsupported_capability",
			message: "provider protocol does not support hosted web search",
			errorReason: { reason: "capability.hosted_search_unsupported", details: { provider: request.provider, model: request.model } },
			outcome: { state: "not_started", effects: "none" },
		});
	}
	return (payload) => {
		payload = imageDetails ? imageDetails(payload) : payload;
		if (!isRecord(payload)) throw unexpectedPayload();
		return {
			...payload,
			tools: responsesToolsWithWebSearch(payload.tools),
		};
	};
}

function responsesToolsWithWebSearch(tools: unknown): readonly unknown[] {
	if (tools === undefined) return [RESPONSES_WEB_SEARCH_TOOL];
	if (!Array.isArray(tools)) throw unexpectedPayload();
	return [...tools, RESPONSES_WEB_SEARCH_TOOL];
}

function unexpectedPayload(): ProviderFailure {
	return new ProviderFailure({
		code: "provider_error",
		message: "pi-ai generated an unexpected provider payload shape",
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
