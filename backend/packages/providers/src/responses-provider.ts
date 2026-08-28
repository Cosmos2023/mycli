import {
	PROVIDER_REPLAY_STATE_MAX_JSON_CHARS,
	type CanonicalConversationItem,
	type CanonicalImage,
	type ProviderEvent,
	type ProviderId,
	type ProviderReplayState,
	type ProviderRequest,
	type ProviderUsage,
	type ToolDefinition,
	type WebSearchAction,
	type WebSearchCall,
} from "@mycli/core";
import {
	classifyProviderError,
	ProviderFailure,
} from "./errors.ts";
import type {
	ModelProvider,
	ProviderStreamOptions,
	ResponsesClient,
} from "./model-provider.ts";
import { imageDataUrl } from "./image-data-url.ts";

export interface ResponsesProviderOptions {
	readonly client: ResponsesClient;
}

const IGNORED_EVENT_TYPES = new Set([
	"response.created",
	"response.in_progress",
	"response.content_part.added",
	"response.content_part.done",
	"response.function_call_arguments.delta",
	"response.function_call_arguments.done",
	"response.output_text.annotation.added",
	"response.output_text.done",
	"response.reasoning_summary_part.added",
	"response.reasoning_summary_part.done",
	"response.reasoning_summary_text.done",
	"response.web_search_call.in_progress",
	"response.web_search_call.searching",
	"response.web_search_call.completed",
]);
const RESPONSES_REASONING_ITEMS_KEY = "responsesReasoningItems";
const RESPONSES_NATIVE_ITEMS_KEY = "responsesNativeItems";
const WEB_SEARCH_CALL_ID_MAX_CHARS = 256;
const WEB_SEARCH_TEXT_MAX_CHARS = 2_048;
const WEB_SEARCH_QUERIES_MAX_ITEMS = 16;

export class ResponsesProvider implements ModelProvider {
	readonly #client: ResponsesClient;

	constructor(options: ResponsesProviderOptions) {
		this.#client = options.client;
	}

	async *stream(
		request: ProviderRequest,
		options: ProviderStreamOptions,
	): AsyncIterable<ProviderEvent> {
		try {
			const stream = await this.#client.create(requestBody(request), options);
			const replayItems: Readonly<Record<string, unknown>>[] = [];
			for await (const rawEvent of stream) {
				const replayItem = completedReplayItem(rawEvent);
				if (replayItem) replayItems.push(replayItem);
				for (const event of mapEvent(rawEvent)) {
					if (event.type === "completed" && replayItems.length > 0) {
						yield responsesProviderState(request.provider, replayItems);
					}
					yield event;
				}
			}
		} catch (error) {
			throw classifyProviderError(error);
		}
	}
}

function requestBody(request: ProviderRequest): Readonly<Record<string, unknown>> {
	const tools = [
		...request.tools.map(responsesTool),
		...(request.webSearchMode === "live" ? [responsesWebSearchTool()] : []),
	];
	return {
		model: request.model,
		instructions: request.instructions,
		input: responsesInput(request),
		stream: true,
		parallel_tool_calls: true,
		...(tools.length > 0
			? { tools }
			: {}),
		...(request.reasoningEffort && request.reasoningEffort !== "none"
			? {
				reasoning: { effort: request.reasoningEffort },
				include: ["reasoning.encrypted_content"],
			}
			: {}),
		...(request.maxOutputTokens === undefined
			? {}
			: { max_output_tokens: request.maxOutputTokens }),
		...(request.store === undefined ? {} : { store: request.store }),
		...(request.promptCacheKey ? { prompt_cache_key: request.promptCacheKey } : {}),
	};
}

function responsesInput(request: ProviderRequest): readonly Readonly<Record<string, unknown>>[] {
	const developer = (request.developerInstructions ?? []).map((content) => ({
		role: "developer",
		content,
	}));
	if (!request.items) {
		return [
			...developer,
			...request.messages.map((message) => ({
				role: message.role,
				content: message.content,
			})),
		];
	}
	return [...developer, ...request.items.flatMap((item) => responsesItem(item, request.provider))];
}

function responsesItem(
	item: CanonicalConversationItem,
	provider: ProviderId,
): readonly Readonly<Record<string, unknown>>[] {
	switch (item.type) {
		case "user":
			return [{ role: "user", content: responsesUserContent(item.text, item.images) }];
		case "assistant":
			return [
				...responsesReplayItems(item.providerState, provider),
				{ role: "assistant", content: item.text },
			];
		case "context":
			return [{ role: item.metadata.role ?? "user", content: item.text }];
		case "assistant_tool_calls":
			return [
				...responsesReplayItems(item.providerState, provider),
				...(item.text ? [{ role: "assistant", content: item.text }] : []),
				...item.calls.map((call) => ({
					type: "function_call",
					call_id: call.callId,
					name: call.name,
					arguments: call.argumentsJson,
				})),
			];
		case "tool_result":
			return [{
				type: "function_call_output",
				call_id: item.callId,
				output: item.output,
			}];
	}
}

function completedReplayItem(rawEvent: unknown): Readonly<Record<string, unknown>> | undefined {
	if (!isRecord(rawEvent) || rawEvent.type !== "response.output_item.done") return undefined;
	return normalizedReplayItem(rawEvent.item);
}

function normalizedReplayItem(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return normalizedReasoningItem(value) ?? normalizedWebSearchItem(value);
}

function normalizedReasoningItem(value: unknown): Readonly<Record<string, unknown>> | undefined {
	if (!isRecord(value) || value.type !== "reasoning") return undefined;
	if (typeof value.encrypted_content !== "string" || !value.encrypted_content) return undefined;
	const summary = reasoningSummary(value.summary);
	if (!summary) return undefined;
	return Object.freeze({
		type: "reasoning",
		...(typeof value.id === "string" && value.id ? { id: value.id } : {}),
		summary,
		encrypted_content: value.encrypted_content,
	});
}

function reasoningSummary(value: unknown): readonly Readonly<Record<string, string>>[] | undefined {
	if (value === undefined) return Object.freeze([]);
	if (!Array.isArray(value)) return undefined;
	const summary: Readonly<Record<string, string>>[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || entry.type !== "summary_text" || typeof entry.text !== "string") {
			return undefined;
		}
		summary.push(Object.freeze({ type: "summary_text", text: entry.text }));
	}
	return Object.freeze(summary);
}

function responsesProviderState(
	provider: ProviderId,
	items: readonly Readonly<Record<string, unknown>>[],
): ProviderEvent {
	const value = Object.freeze({
		[RESPONSES_NATIVE_ITEMS_KEY]: Object.freeze([...items]),
	});
	if (JSON.stringify(value).length > PROVIDER_REPLAY_STATE_MAX_JSON_CHARS) {
		throw new ProviderFailure({
			code: "provider_error",
			message: "Responses native replay state exceeds the supported limit",
		});
	}
	return {
		type: "provider_state",
		state: Object.freeze({ provider, value }),
	};
}

function responsesReplayItems(
	state: ProviderReplayState | undefined,
	provider: ProviderId,
): readonly Readonly<Record<string, unknown>>[] {
	if (!state || state.provider !== provider) return [];
	const value = state.value[RESPONSES_NATIVE_ITEMS_KEY]
		?? state.value[RESPONSES_REASONING_ITEMS_KEY];
	if (!Array.isArray(value)) return [];
	const items: Readonly<Record<string, unknown>>[] = [];
	for (const candidate of value) {
		const item = normalizedReplayItem(candidate);
		if (!item) return [];
		items.push(item);
	}
	return Object.freeze(items);
}

function responsesUserContent(
	text: string,
	images: readonly CanonicalImage[] | undefined,
): string | readonly Readonly<Record<string, unknown>>[] {
	if (!images || images.length === 0) return text;
	return Object.freeze([
		...(text ? [{ type: "input_text", text }] : []),
		...images.map((image) => ({
			type: "input_image",
			image_url: imageDataUrl(image),
		})),
	]);
}

function responsesTool(tool: ToolDefinition): Readonly<Record<string, unknown>> {
	return {
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.inputSchema,
	};
}

function responsesWebSearchTool(): Readonly<Record<string, unknown>> {
	return Object.freeze({
		type: "web_search",
		external_web_access: true,
	});
}

function mapEvent(rawEvent: unknown): readonly ProviderEvent[] {
	if (!isRecord(rawEvent) || typeof rawEvent.type !== "string") {
		throw new ProviderFailure({
			code: "provider_error",
			message: "malformed Responses stream event",
		});
	}
	if (rawEvent.type === "response.reasoning_summary_text.delta") {
		return typeof rawEvent.delta === "string" && rawEvent.delta
			? [{ type: "reasoning_delta", text: rawEvent.delta }]
			: [];
	}
	if (rawEvent.type === "response.output_text.delta") {
		return typeof rawEvent.delta === "string" && rawEvent.delta
			? [{ type: "text_delta", text: rawEvent.delta }]
			: [];
	}
	if (rawEvent.type === "response.output_item.added") {
		return webSearchStartedEvent(rawEvent.item);
	}
	if (rawEvent.type === "response.output_item.done") {
		return outputItemDoneEvents(rawEvent.item);
	}
	if (rawEvent.type === "response.completed") {
		return completionEvents(rawEvent.response);
	}
	if (rawEvent.type === "response.failed" || rawEvent.type === "response.incomplete") {
		throw classifyProviderError(rawEvent.response);
	}
	if (rawEvent.type === "error") {
		throw classifyProviderError(rawEvent.error ?? rawEvent);
	}
	if (IGNORED_EVENT_TYPES.has(rawEvent.type)) {
		return [];
	}
	throw new ProviderFailure({
		code: "provider_error",
		message: "unsupported Responses stream event",
		diagnostics: { event_type: rawEvent.type.slice(0, 128) },
	});
}

function webSearchStartedEvent(item: unknown): readonly ProviderEvent[] {
	if (!isRecord(item) || item.type !== "web_search_call") return [];
	const callId = webSearchCallId(item.id);
	return [{ type: "web_search_started", callId }];
}

function outputItemDoneEvents(item: unknown): readonly ProviderEvent[] {
	if (!isRecord(item)) return [];
	if (item.type === "web_search_call") {
		const call = webSearchCall(item);
		return [{ type: "web_search_completed", call }];
	}
	if (item.type !== "function_call") {
		return [];
	}
	if (typeof item.name !== "string" || typeof item.arguments !== "string") {
		throw new ProviderFailure({
			code: "provider_error",
			message: "malformed Responses tool call",
		});
	}
	if (typeof item.call_id !== "string" || !item.call_id) {
		throw new ProviderFailure({
			code: "tool_protocol_error",
			message: "Responses tool call is missing a call id",
		});
	}
	return [{
		type: "tool_call",
		callId: item.call_id,
		name: item.name,
		argumentsJson: item.arguments,
	}];
}

function normalizedWebSearchItem(value: unknown): Readonly<Record<string, unknown>> | undefined {
	if (!isRecord(value) || value.type !== "web_search_call") return undefined;
	const call = webSearchCall(value);
	return Object.freeze({
		type: "web_search_call",
		id: call.callId,
		status: "completed",
		action: call.action,
	});
}

function webSearchCall(value: Readonly<Record<string, unknown>>): WebSearchCall {
	return Object.freeze({
		callId: webSearchCallId(value.id),
		action: webSearchAction(value.action),
	});
}

function webSearchCallId(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new ProviderFailure({
			code: "provider_error",
			message: "Responses web search call is missing an id",
		});
	}
	return value.slice(0, WEB_SEARCH_CALL_ID_MAX_CHARS);
}

function webSearchAction(value: unknown): WebSearchAction {
	if (!isRecord(value) || typeof value.type !== "string") {
		return Object.freeze({ type: "other" });
	}
	switch (value.type) {
		case "search": {
			const query = webSearchText(value.query);
			const queries = Array.isArray(value.queries)
				? Object.freeze(value.queries
					.slice(0, WEB_SEARCH_QUERIES_MAX_ITEMS)
					.map(webSearchText)
					.filter((item): item is string => item !== undefined))
				: undefined;
			return Object.freeze({
				type: "search",
				...(query ? { query } : {}),
				...(queries && queries.length > 0 ? { queries } : {}),
			});
		}
		case "open_page": {
			const url = webSearchText(value.url);
			return Object.freeze({ type: "open_page", ...(url ? { url } : {}) });
		}
		case "find_in_page": {
			const url = webSearchText(value.url);
			const pattern = webSearchText(value.pattern);
			return Object.freeze({
				type: "find_in_page",
				...(url ? { url } : {}),
				...(pattern ? { pattern } : {}),
			});
		}
		default:
			return Object.freeze({ type: "other" });
	}
}

function webSearchText(value: unknown): string | undefined {
	return typeof value === "string" && value
		? value.slice(0, WEB_SEARCH_TEXT_MAX_CHARS)
		: undefined;
}

function completionEvents(response: unknown): readonly ProviderEvent[] {
	if (!isRecord(response)) {
		throw new ProviderFailure({
			code: "provider_error",
			message: "malformed Responses completion",
		});
	}
	const events: ProviderEvent[] = [];
	const usage = usageFrom(response.usage);
	if (Object.keys(usage).length > 0) {
		events.push({ type: "usage", usage });
	}
	events.push({
		type: "completed",
		...(typeof response.id === "string" ? { responseId: response.id } : {}),
	});
	return events;
}

function usageFrom(value: unknown): ProviderUsage {
	if (!isRecord(value)) {
		return {};
	}
	const usage: Record<string, number> = {};
	copyNumber(value, "input_tokens", usage);
	copyNumber(value, "output_tokens", usage);
	copyNumber(value, "total_tokens", usage);
	if (isRecord(value.input_tokens_details)) {
		const cached = value.input_tokens_details.cached_tokens;
		if (typeof cached === "number" && Number.isFinite(cached)) {
			usage.cached_tokens = cached;
		}
	}
	if (isRecord(value.output_tokens_details)) {
		const reasoning = value.output_tokens_details.reasoning_tokens;
		if (typeof reasoning === "number" && Number.isFinite(reasoning)) {
			usage.reasoning_tokens = reasoning;
		}
	}
	return usage;
}

function copyNumber(source: Record<string, unknown>, key: string, target: Record<string, number>): void {
	const value = source[key];
	if (typeof value === "number" && Number.isFinite(value)) {
		target[key] = value;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
