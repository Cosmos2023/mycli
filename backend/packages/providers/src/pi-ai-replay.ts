import { createHash } from "node:crypto";
import type {
	AssistantMessage,
	ThinkingContent,
	ToolCall,
} from "@earendil-works/pi-ai";
import {
	isProviderId,
	isProviderRouteId,
	PROVIDER_REPLAY_STATE_MAX_JSON_CHARS,
	type CanonicalConversationItem,
	type ProviderEvent,
	type ProviderRouteId,
	type ProviderReplayState,
} from "@mycli/core";
import { ProviderFailure } from "./errors.ts";
import { serializeJsonObject } from "./json-object.ts";
import type { PiAiApi } from "./pi-ai-model.ts";

const REPLAY_KIND = "pi_ai_assistant";
const REPLAY_VERSION = 2;
const REPLAY_TRANSPORT_VERSION = 1;
const RESPONSES_NATIVE_ITEMS_KEY = "responsesNativeItems";
const RESPONSES_REASONING_ITEMS_KEY = "responsesReasoningItems";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface PiAiReplayProjection {
	readonly thinking: readonly ThinkingContent[];
	readonly responseId?: string;
	readonly textSignature?: string;
	readonly nativeToolIds: ReadonlyMap<string, string>;
	readonly toolThoughtSignatures: ReadonlyMap<string, string>;
	readonly diagnostic?: PiAiReplayDiagnostic;
}

export interface PiAiReplayTransportIdentity {
	readonly version: typeof REPLAY_TRANSPORT_VERSION;
	readonly routeId: ProviderRouteId;
	readonly catalogProviderId?: ProviderRouteId;
	readonly api: PiAiApi;
	readonly model: string;
	readonly endpointSha256: string;
}

export interface PiAiReplayDiagnostic {
	readonly code: "provider_replay_degraded";
	readonly reason:
		| "content_mismatch"
		| "foreign_identity"
		| "foreign_provider"
		| "legacy_transport_unbound"
		| "malformed"
		| "oversized"
		| "transport_mismatch"
		| "unsupported_format"
		| "unsupported_version";
}

export function restorePiAiReplay(
	item: Extract<CanonicalConversationItem, { type: "assistant" | "assistant_tool_calls" }>,
	api: PiAiApi,
	provider: ProviderRouteId,
	model: string,
	transport?: PiAiReplayTransportIdentity,
): PiAiReplayProjection {
	const state = item.providerState;
	if (!state) return emptyProjection();
	if (state.provider !== provider) return emptyProjection("foreign_provider");
	if (!replayValueWithinLimit(state.value)) return emptyProjection("oversized");
	if (state.value.kind === REPLAY_KIND) {
		if (state.value.version === REPLAY_VERSION) {
			if (!transport) return emptyProjection("transport_mismatch");
			return currentReplay(state, item, transport);
		}
		if (state.value.version === 1 && isProviderId(provider)) {
			return versionOneReplay(state, item, api, provider, model);
		}
		if (state.value.version === 1) return emptyProjection("legacy_transport_unbound");
		return emptyProjection("unsupported_version");
	}
	if ("kind" in state.value) return emptyProjection("unsupported_format");
	if (!isProviderId(provider)) return emptyProjection("legacy_transport_unbound");
	return legacyReplay(state, provider);
}

export function piAiProviderStateEvent(
	message: AssistantMessage,
	provider: ProviderRouteId,
	transport: PiAiReplayTransportIdentity,
): ProviderEvent | undefined {
	const textBlocks = message.content.flatMap((block) => block.type === "text"
		? [{
			text: block.text,
			...(block.textSignature ? { textSignature: block.textSignature } : {}),
		}]
		: []);
	const thinkingBlocks = message.content.flatMap((block) => block.type === "thinking"
		? [{
			thinking: block.thinking,
			...(block.thinkingSignature ? { thinkingSignature: block.thinkingSignature } : {}),
			...(block.redacted === true ? { redacted: true } : {}),
		}]
		: []);
	const toolCalls = message.content.flatMap((block) => block.type === "toolCall"
		? [{
			callId: canonicalToolCallId(block.id),
			nativeId: block.id,
			name: block.name,
			argumentsJson: replayArgumentsJson(block.arguments),
			...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}),
		}]
		: []);
	const hasNativeMetadata = message.responseId !== undefined
		|| textBlocks.some((block) => block.textSignature !== undefined)
		|| thinkingBlocks.length > 0
		|| toolCalls.some((call) => call.nativeId !== call.callId || call.thoughtSignature !== undefined);
	if (!hasNativeMetadata) return undefined;
	const value = Object.freeze({
		kind: REPLAY_KIND,
		version: REPLAY_VERSION,
		transport,
		...(message.responseId ? { responseId: message.responseId } : {}),
		textBlocks: Object.freeze(textBlocks),
		thinkingBlocks: Object.freeze(thinkingBlocks),
		toolCalls: Object.freeze(toolCalls),
	});
	if (JSON.stringify(value).length > PROVIDER_REPLAY_STATE_MAX_JSON_CHARS) {
		throw new ProviderFailure({
			code: "provider_error",
			message: "pi-ai replay state exceeds the supported limit",
		});
	}
	return {
		type: "provider_state",
		state: Object.freeze({ provider, value }),
	};
}

export function piAiReplayTransportIdentity(input: {
	readonly routeId: ProviderRouteId;
	readonly catalogProviderId?: ProviderRouteId;
	readonly api: PiAiApi;
	readonly model: string;
	readonly apiBaseUrl: string;
}): PiAiReplayTransportIdentity {
	return Object.freeze({
		version: REPLAY_TRANSPORT_VERSION,
		routeId: input.routeId,
		...(input.catalogProviderId === undefined
			? {}
			: { catalogProviderId: input.catalogProviderId }),
		api: input.api,
		model: input.model,
		endpointSha256: endpointSha256(input.apiBaseUrl),
	});
}

function parseReplayTransport(value: unknown): PiAiReplayTransportIdentity | undefined {
	if (!isRecord(value)) return undefined;
	const expectedKeys = [
		"api",
		"endpointSha256",
		"model",
		"routeId",
		"version",
		...(value.catalogProviderId === undefined ? [] : ["catalogProviderId"]),
	].sort();
	if (!sameStringArray(Object.keys(value).sort(), expectedKeys)) return undefined;
	if (value.version !== REPLAY_TRANSPORT_VERSION
		|| !isProviderRouteId(value.routeId)
		|| (value.catalogProviderId !== undefined && !isProviderRouteId(value.catalogProviderId))
		|| !isPiAiApi(value.api)
		|| typeof value.model !== "string"
		|| value.model.length === 0
		|| value.model.length > 512
		|| typeof value.endpointSha256 !== "string"
		|| !SHA256_PATTERN.test(value.endpointSha256)) {
		return undefined;
	}
	return Object.freeze({
		version: REPLAY_TRANSPORT_VERSION,
		routeId: value.routeId,
		...(value.catalogProviderId === undefined
			? {}
			: { catalogProviderId: value.catalogProviderId }),
		api: value.api,
		model: value.model,
		endpointSha256: value.endpointSha256,
	});
}

function sameReplayTransport(
	left: PiAiReplayTransportIdentity,
	right: PiAiReplayTransportIdentity,
): boolean {
	return left.version === right.version
		&& left.routeId === right.routeId
		&& left.catalogProviderId === right.catalogProviderId
		&& left.api === right.api
		&& left.model === right.model
		&& left.endpointSha256 === right.endpointSha256;
}

function endpointSha256(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw invalidReplayEndpoint();
	}
	if ((url.protocol !== "https:" && url.protocol !== "http:")
		|| url.username || url.password || url.search || url.hash) {
		throw invalidReplayEndpoint();
	}
	const pathname = url.pathname.replace(/\/+$/u, "");
	return createHash("sha256")
		.update(`${url.origin}${pathname}`, "utf8")
		.digest("hex");
}

function invalidReplayEndpoint(): ProviderFailure {
	return new ProviderFailure({
		code: "config_error",
		message: "provider replay endpoint identity is invalid",
	});
}

function isPiAiApi(value: unknown): value is PiAiApi {
	return value === "openai-responses"
		|| value === "openai-completions"
		|| value === "anthropic-messages";
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function replayArgumentsJson(value: unknown): string {
	const serialized = serializeJsonObject(value);
	if (serialized) return serialized;
	throw invalidReplayArguments();
}

function invalidReplayArguments(): ProviderFailure {
	return new ProviderFailure({
		code: "tool_protocol_error",
		message: "pi-ai tool arguments must be a JSON object",
	});
}

function currentReplay(
	state: ProviderReplayState,
	item: Extract<CanonicalConversationItem, { type: "assistant" | "assistant_tool_calls" }>,
	transport: PiAiReplayTransportIdentity,
): PiAiReplayProjection {
	const value = state.value;
	const restoredTransport = parseReplayTransport(value.transport);
	if (!restoredTransport) return emptyProjection("malformed");
	if (!sameReplayTransport(restoredTransport, transport)) {
		return emptyProjection("transport_mismatch");
	}
	return replayContent(value, item);
}

function versionOneReplay(
	state: ProviderReplayState,
	item: Extract<CanonicalConversationItem, { type: "assistant" | "assistant_tool_calls" }>,
	api: PiAiApi,
	provider: ProviderRouteId,
	model: string,
): PiAiReplayProjection {
	const value = state.value;
	if (value.api !== api || value.provider !== provider || value.model !== model) {
		return emptyProjection("foreign_identity");
	}
	return replayContent(value, item);
}

function replayContent(
	value: Readonly<Record<string, unknown>>,
	item: Extract<CanonicalConversationItem, { type: "assistant" | "assistant_tool_calls" }>,
): PiAiReplayProjection {
	const textBlocks = parseCurrentTextBlocks(value.textBlocks);
	const thinking = parseThinkingBlocks(value.thinkingBlocks);
	if (!textBlocks || !thinking || !Array.isArray(value.toolCalls)) {
		return emptyProjection("malformed");
	}
	if (textBlocks.map((block) => block.text).join("") !== item.text) {
		return emptyProjection("content_mismatch");
	}
	if (value.responseId !== undefined
		&& (typeof value.responseId !== "string" || !value.responseId)) {
		return emptyProjection("malformed");
	}
	const textSignature = textBlocks.length === 1
		&& typeof textBlocks[0].textSignature === "string"
		? textBlocks[0].textSignature
		: undefined;
	const nativeToolIds = new Map<string, string>();
	const toolThoughtSignatures = new Map<string, string>();
	if (item.type === "assistant") {
		if (value.toolCalls.length > 0) return emptyProjection("content_mismatch");
	} else {
		if (value.toolCalls.length !== item.calls.length) return emptyProjection("content_mismatch");
		for (const candidate of value.toolCalls) {
			if (!isRecord(candidate)
				|| typeof candidate.callId !== "string"
				|| typeof candidate.nativeId !== "string"
				|| typeof candidate.name !== "string"
				|| typeof candidate.argumentsJson !== "string"
				|| (candidate.thoughtSignature !== undefined
					&& typeof candidate.thoughtSignature !== "string")) {
				return emptyProjection("malformed");
			}
			const canonical = item.calls.find((call) => call.callId === candidate.callId);
			if (!canonical || canonical.name !== candidate.name
				|| canonicalToolCallId(candidate.nativeId) !== canonical.callId
				|| !sameJsonObject(canonical.argumentsJson, candidate.argumentsJson)) {
				return emptyProjection("content_mismatch");
			}
			nativeToolIds.set(canonical.callId, candidate.nativeId);
			if (typeof candidate.thoughtSignature === "string") {
				toolThoughtSignatures.set(canonical.callId, candidate.thoughtSignature);
			}
		}
	}
	return Object.freeze({
		thinking,
		...(typeof value.responseId === "string" ? { responseId: value.responseId } : {}),
		...(textSignature ? { textSignature } : {}),
		nativeToolIds,
		toolThoughtSignatures,
	});
}

function legacyReplay(
	state: ProviderReplayState,
	provider: ProviderRouteId,
): PiAiReplayProjection {
	if (provider === "anthropic") {
		const thinking = parseLegacyAnthropicThinking(state.value.thinkingBlocks);
		if (!thinking) return emptyProjection("malformed");
		return Object.freeze({
			thinking,
			nativeToolIds: new Map(),
			toolThoughtSignatures: new Map(),
		});
	}
	if (provider === "deepseek") {
		if (typeof state.value.reasoningContent !== "string") {
			return emptyProjection("malformed");
		}
		return Object.freeze({
			thinking: state.value.reasoningContent
				? [{
					type: "thinking" as const,
					thinking: state.value.reasoningContent,
					thinkingSignature: "reasoning_content",
				}]
				: [],
			nativeToolIds: new Map(),
			toolThoughtSignatures: new Map(),
		});
	}
	const nativeItems = state.value[RESPONSES_NATIVE_ITEMS_KEY]
		?? state.value[RESPONSES_REASONING_ITEMS_KEY];
	const thinking = parseLegacyResponsesThinking(nativeItems);
	if (!thinking) return emptyProjection("malformed");
	return Object.freeze({
		thinking,
		nativeToolIds: new Map(),
		toolThoughtSignatures: new Map(),
	});
}

function parseCurrentTextBlocks(
	value: unknown,
): readonly Readonly<{ text: string; textSignature?: string }>[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const blocks: Array<{ text: string; textSignature?: string }> = [];
	for (const block of value) {
		if (!isRecord(block) || typeof block.text !== "string"
			|| (block.textSignature !== undefined && typeof block.textSignature !== "string")) {
			return undefined;
		}
		blocks.push({
			text: block.text,
			...(typeof block.textSignature === "string"
				? { textSignature: block.textSignature }
				: {}),
		});
	}
	return Object.freeze(blocks);
}

function parseThinkingBlocks(value: unknown): readonly ThinkingContent[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const blocks: ThinkingContent[] = [];
	for (const block of value) {
		if (!isRecord(block) || typeof block.thinking !== "string"
			|| (block.thinkingSignature !== undefined
				&& typeof block.thinkingSignature !== "string")
			|| (block.redacted !== undefined && typeof block.redacted !== "boolean")) {
			return undefined;
		}
		blocks.push({
			type: "thinking" as const,
			thinking: block.thinking,
			...(typeof block.thinkingSignature === "string"
				? { thinkingSignature: block.thinkingSignature }
				: {}),
			...(block.redacted === true ? { redacted: true } : {}),
		});
	}
	return Object.freeze(blocks);
}

function parseLegacyAnthropicThinking(value: unknown): readonly ThinkingContent[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const blocks: ThinkingContent[] = [];
	for (const block of value) {
		if (!isRecord(block) || typeof block.thinking !== "string"
			|| typeof block.signature !== "string") return undefined;
		blocks.push({
			type: "thinking" as const,
			thinking: block.thinking,
			thinkingSignature: block.signature,
		});
	}
	return Object.freeze(blocks);
}

function parseLegacyResponsesThinking(value: unknown): readonly ThinkingContent[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const blocks: ThinkingContent[] = [];
	for (const item of value) {
		if (isRecord(item) && item.type === "web_search_call") continue;
		if (!isRecord(item) || item.type !== "reasoning"
			|| typeof item.encrypted_content !== "string") return undefined;
		const summary = Array.isArray(item.summary)
			? item.summary.flatMap((part) => isRecord(part)
				&& part.type === "summary_text"
				&& typeof part.text === "string" ? [part.text] : [])
			: [];
		if (!Array.isArray(item.summary) || summary.length !== item.summary.length) return undefined;
		blocks.push({
			type: "thinking" as const,
			thinking: summary.join("\n\n"),
			thinkingSignature: JSON.stringify(item),
		});
	}
	return Object.freeze(blocks);
}

export function piAiToolCall(
	callId: string,
	name: string,
	argumentsJson: string,
	replay: PiAiReplayProjection,
): ToolCall {
	return {
		type: "toolCall",
		id: replay.nativeToolIds.get(callId) ?? callId,
		name,
		arguments: parseArguments(argumentsJson),
		...(replay.toolThoughtSignatures.get(callId)
			? { thoughtSignature: replay.toolThoughtSignatures.get(callId) }
			: {}),
	};
}

export function emptyPiAiUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function canonicalToolCallId(nativeId: string): string {
	const separator = nativeId.indexOf("|");
	return separator === -1 ? nativeId : nativeId.slice(0, separator);
}

function parseArguments(value: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (isRecord(parsed)) return parsed;
	} catch {
		// Canonical tool arguments are validated at the provider boundary below.
	}
	throw new ProviderFailure({
		code: "tool_protocol_error",
		message: "canonical tool arguments must be a JSON object",
	});
}

function sameJsonObject(left: string, right: string): boolean {
	try {
		const leftValue = JSON.parse(left) as unknown;
		const rightValue = JSON.parse(right) as unknown;
		return isRecord(leftValue) && isRecord(rightValue) && sameJsonValue(leftValue, rightValue);
	} catch {
		return false;
	}
}

function sameJsonValue(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left) && Array.isArray(right)
			&& left.length === right.length
			&& left.every((value, index) => sameJsonValue(value, right[index]));
	}
	if (!isRecord(left) || !isRecord(right)) return false;
	const leftKeys = Object.keys(left).sort();
	const rightKeys = Object.keys(right).sort();
	return leftKeys.length === rightKeys.length
		&& leftKeys.every((key, index) => key === rightKeys[index]
			&& sameJsonValue(left[key], right[key]));
}

function replayValueWithinLimit(value: Readonly<Record<string, unknown>>): boolean {
	try {
		const serialized = JSON.stringify(value);
		return serialized.length > 0 && serialized.length <= PROVIDER_REPLAY_STATE_MAX_JSON_CHARS;
	} catch {
		return false;
	}
}

function emptyProjection(
	reason?: PiAiReplayDiagnostic["reason"],
): PiAiReplayProjection {
	return Object.freeze({
		thinking: Object.freeze([]),
		nativeToolIds: new Map(),
		toolThoughtSignatures: new Map(),
		...(reason
			? { diagnostic: Object.freeze({ code: "provider_replay_degraded" as const, reason }) }
			: {}),
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
