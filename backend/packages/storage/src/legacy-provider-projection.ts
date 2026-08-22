import {
	PROVIDER_REPLAY_STATE_MAX_JSON_CHARS,
	type CanonicalContextMetadata,
	type CanonicalConversationItem,
	type CanonicalToolCall,
	type ProviderReplayState,
} from "@mycli/core";
import { canonicalImageBlocks } from "./canonical-images.ts";
import { StorageFailure } from "./session-store.ts";
import { stableJson } from "./stable-json.ts";

const MAX_CONTEXT_CONTENT_CHARS = 65_536;
const MAX_CONTEXT_SOURCE_ID_CHARS = 128;
const PROVIDER_IDS = new Set(["openai", "codex", "compatible", "qwen", "deepseek", "anthropic"]);

export function canonicalConversationItem(
	payloadJson: unknown,
	source: string,
): CanonicalConversationItem {
	const payload = parseObjectJson(payloadJson, source);
	if (payload.role === "user" && typeof payload.content === "string") {
		const images = canonicalImageBlocks(payload.blocks, source);
		return Object.freeze({
			type: "user" as const,
			text: payload.content,
			...(images.length > 0 ? { images } : {}),
		});
	}
	if (payload.role === "assistant" && typeof payload.content === "string") {
		const metadata = recordValue(payload.metadata);
		const providerState = canonicalProviderState(metadata.provider_state);
		const calls = canonicalToolCalls(payload.tool_calls, source);
		if (calls.length > 0) {
			return Object.freeze({
				type: "assistant_tool_calls" as const,
				text: payload.content,
				calls,
				...(typeof payload.response_id === "string"
					? { responseId: payload.response_id }
					: {}),
				...(providerState ? { providerState } : {}),
			});
		}
		return Object.freeze({
			type: "assistant" as const,
			text: payload.content,
			...(providerState ? { providerState } : {}),
		});
	}
	if (payload.role === "context" && typeof payload.content === "string") {
		return Object.freeze({
			type: "context" as const,
			text: payload.content,
			metadata: canonicalContextMetadata(recordValue(payload.metadata).context),
		});
	}
	if (payload.role === "tool" && typeof payload.content === "string"
		&& typeof payload.tool_call_id === "string" && payload.tool_call_id) {
		const metadata = recordValue(payload.metadata);
		const block = firstBlock(payload.blocks, "tool_result");
		const blockMetadata = recordValue(block?.metadata);
		const toolName = stringValue(metadata.tool_name)
			?? stringValue(block?.tool_name)
			?? "Tool";
		const success = booleanValue(metadata.success)
			?? booleanValue(blockMetadata.success)
			?? true;
		return Object.freeze({
			type: "tool_result" as const,
			callId: payload.tool_call_id,
			toolName,
			output: payload.content,
			success,
		});
	}
	throw new StorageFailure(`invalid canonical message in ${source}`);
}

export function canonicalHistoryItem(payloadJson: unknown): CanonicalConversationItem {
	const payload = parseObjectJson(payloadJson, "history_items");
	if (payload.type === "user_message" && typeof payload.text === "string") {
		return Object.freeze({ type: "user" as const, text: payload.text });
	}
	if (payload.type === "assistant_message" && typeof payload.text === "string") {
		const providerState = canonicalProviderState(recordValue(payload.metadata).provider_state);
		return Object.freeze({
			type: "assistant" as const,
			text: payload.text,
			...(providerState ? { providerState } : {}),
		});
	}
	const metadata = recordValue(payload.metadata);
	if (payload.type === "skill_instructions" && typeof payload.text === "string") {
		return Object.freeze({
			type: "context" as const,
			text: payload.text,
			metadata: canonicalContextMetadata(metadata),
		});
	}
	if (payload.type === "tool_call") {
		const name = stringValue(payload.tool_name);
		const callId = stringValue(payload.call_id);
		if (!name || !callId) {
			throw new StorageFailure("invalid canonical message in history_items");
		}
		const providerState = canonicalProviderState(metadata.provider_state);
		return Object.freeze({
			type: "assistant_tool_calls" as const,
			text: stringValue(payload.text) ?? "",
			calls: Object.freeze([Object.freeze({
				callId,
				name,
				argumentsJson: stableJson(recordValue(metadata.arguments)),
			})]),
			...(stringValue(metadata.response_id)
				? { responseId: stringValue(metadata.response_id) }
				: {}),
			...(providerState ? { providerState } : {}),
		});
	}
	if (payload.type === "tool_result") {
		const name = stringValue(payload.tool_name);
		const callId = stringValue(payload.call_id);
		const output = stringValue(metadata.transcript_content) ?? stringValue(payload.text);
		if (!name || !callId || output === undefined) {
			throw new StorageFailure("invalid canonical message in history_items");
		}
		return Object.freeze({
			type: "tool_result" as const,
			callId,
			toolName: name,
			output,
			success: booleanValue(metadata.success) ?? true,
		});
	}
	throw new StorageFailure("invalid canonical message in history_items");
}

export function conversationSearchText(item: CanonicalConversationItem): string {
	if (item.type === "tool_result") return item.output;
	return item.text;
}

export function conversationSearchRole(item: CanonicalConversationItem): string {
	if (item.type === "assistant" || item.type === "assistant_tool_calls") return "assistant";
	if (item.type === "tool_result") return "tool";
	if (item.type === "context") return "context";
	return "user";
}

export function repairTerminalToolProtocol(
	items: readonly CanonicalConversationItem[],
	activeToolCallIds: ReadonlySet<string>,
): readonly CanonicalConversationItem[] {
	const callIds = new Set<string>();
	const results = new Map<string, Extract<CanonicalConversationItem, { readonly type: "tool_result" }>>();
	for (const item of items) {
		if (item.type === "assistant_tool_calls") {
			for (const call of item.calls) callIds.add(call.callId);
		} else if (item.type === "tool_result") {
			results.set(item.callId, item);
		}
	}
	const projected: CanonicalConversationItem[] = [];
	for (const item of items) {
		if (item.type === "assistant_tool_calls") {
			projected.push(item);
			for (const call of item.calls) {
				const result = results.get(call.callId);
				if (result) {
					projected.push(result);
				} else if (!activeToolCallIds.has(call.callId)) {
					projected.push(Object.freeze({
						type: "tool_result" as const,
						callId: call.callId,
						toolName: call.name,
						output: "Tool result unavailable because the previous turn ended before persistence completed.",
						success: false,
					}));
				}
			}
			continue;
		}
		if (item.type === "tool_result" && callIds.has(item.callId)) continue;
		projected.push(item);
	}
	return Object.freeze(projected);
}

function canonicalContextMetadata(value: unknown): CanonicalContextMetadata {
	const metadata = recordValue(value);
	const canonical: CanonicalContextMetadata = {
		kind: metadata.kind as CanonicalContextMetadata["kind"],
		...((metadata.role === "developer" || metadata.role === "user")
			? { role: metadata.role }
			: {}),
		cacheClass: (metadata.cache_class ?? metadata.cacheClass) as CanonicalContextMetadata["cacheClass"],
		durability: metadata.durability as CanonicalContextMetadata["durability"],
		scope: metadata.scope as CanonicalContextMetadata["scope"],
		sourceId: String(metadata.source_id ?? metadata.sourceId ?? ""),
		contentSha256: String(metadata.content_sha256 ?? metadata.contentSha256 ?? ""),
		contentLength: Number(metadata.content_length ?? metadata.contentLength),
	};
	const validSource = canonical.sourceId.length > 0
		&& canonical.sourceId.length <= MAX_CONTEXT_SOURCE_ID_CHARS
		&& !canonical.sourceId.includes("/")
		&& !canonical.sourceId.includes("\\")
		&& !canonical.sourceId.includes("\0");
	if ((canonical.kind !== "skill_instructions" && canonical.kind !== "turn_aborted")
		|| canonical.cacheClass !== "dynamic"
		|| canonical.durability !== "persistent"
		|| canonical.scope !== "transcript"
		|| !validSource
		|| !/^[a-f0-9]{64}$/u.test(canonical.contentSha256)
		|| !Number.isSafeInteger(canonical.contentLength)
		|| canonical.contentLength < 0
		|| canonical.contentLength > MAX_CONTEXT_CONTENT_CHARS) {
		throw new StorageFailure("invalid canonical context item");
	}
	return Object.freeze(canonical);
}

function canonicalProviderState(value: unknown): ProviderReplayState | undefined {
	if (value === undefined || value === null) return undefined;
	const state = recordValue(value);
	const provider = stringValue(state.provider);
	if (!provider || !PROVIDER_IDS.has(provider)) {
		throw new StorageFailure("invalid provider replay state");
	}
	let json: string;
	try {
		json = stableJson(state.value);
	} catch {
		throw new StorageFailure("invalid provider replay state");
	}
	if (!json || json.length > PROVIDER_REPLAY_STATE_MAX_JSON_CHARS) {
		throw new StorageFailure("invalid provider replay state");
	}
	const stateValue = JSON.parse(json) as unknown;
	if (!isRecord(stateValue)) throw new StorageFailure("invalid provider replay state");
	const tokenEstimate = state.tokenEstimate;
	if (tokenEstimate !== undefined
		&& (typeof tokenEstimate !== "number"
			|| !Number.isSafeInteger(tokenEstimate)
			|| tokenEstimate < 0)) {
		throw new StorageFailure("invalid provider replay state");
	}
	return Object.freeze({
		provider: provider as ProviderReplayState["provider"],
		value: Object.freeze(stateValue),
		...(tokenEstimate === undefined ? {} : { tokenEstimate }),
	});
}

function canonicalToolCalls(value: unknown, source: string): readonly CanonicalToolCall[] {
	if (value === undefined || value === null) return Object.freeze([]);
	if (!Array.isArray(value)) {
		throw new StorageFailure(`invalid canonical message in ${source}`);
	}
	return Object.freeze(value.map((raw) => {
		const call = recordValue(raw);
		const name = stringValue(call.name);
		const callId = stringValue(call.call_id);
		if (!name || !callId) {
			throw new StorageFailure(`invalid canonical message in ${source}`);
		}
		return Object.freeze({
			callId,
			name,
			argumentsJson: stableJson(recordValue(call.arguments)),
		});
	}));
}

function parseObjectJson(value: unknown, source: string): Readonly<Record<string, unknown>> {
	try {
		const parsed = JSON.parse(String(value)) as unknown;
		if (!isRecord(parsed)) throw new Error("not an object");
		return parsed;
	} catch {
		throw new StorageFailure(`invalid JSON in ${source}`);
	}
}

function firstBlock(value: unknown, type: string): Readonly<Record<string, unknown>> | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.map(recordValue).find((block) => block.type === type);
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
	return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
