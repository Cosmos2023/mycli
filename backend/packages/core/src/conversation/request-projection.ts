import {
	PROVIDER_REPLAY_STATE_MAX_JSON_CHARS,
	type CanonicalConversationItem,
	type CanonicalContextMetadata,
	type CanonicalMessage,
	type ProviderRequest,
	type ProviderRequestConfig,
	type ProviderReplayState,
	type ToolDefinition,
} from "../types.ts";
import { parseProviderNativeTransportSnapshot } from "./provider-native-transport.ts";

export interface NoToolRequestProjectionInput {
	readonly config: ProviderRequestConfig;
	readonly instructions: string;
	readonly developerInstructions?: readonly string[];
	readonly history: readonly CanonicalMessage[];
	readonly userText: string;
}

interface ProviderRequestProjectionBase {
	readonly config: ProviderRequestConfig;
	readonly instructions: string;
	readonly developerInstructions?: readonly string[];
	readonly tools: readonly ToolDefinition[];
	readonly previousResponseId?: string;
}

export interface ProviderRequestFragments {
	readonly compactedSummary?: readonly CanonicalConversationItem[];
	readonly retainedTail?: readonly CanonicalConversationItem[];
	readonly rehydration?: readonly Extract<CanonicalConversationItem, { readonly type: "user" }>[];
	readonly memory?: readonly Extract<CanonicalConversationItem, { readonly type: "user" }>[];
	readonly currentInput: Extract<CanonicalConversationItem, { readonly type: "user" }>;
	readonly steers?: readonly Extract<CanonicalConversationItem, { readonly type: "user" }>[];
}

export type ProviderRequestProjectionInput = ProviderRequestProjectionBase & (
	| {
		readonly history: readonly CanonicalConversationItem[];
		readonly fragments?: never;
	}
	| {
		readonly history?: never;
		readonly fragments: ProviderRequestFragments;
	}
);

export function projectProviderRequest(input: ProviderRequestProjectionInput): ProviderRequest {
	const items = orderProviderConversationItems(providerItems(input)).map(copyConversationItem);
	const messages = items.flatMap((item): CanonicalMessage[] => {
		if (item.type === "user") {
			return [{ role: "user", content: item.text }];
		}
		if (item.type === "assistant") {
			return [{ role: "assistant", content: item.text }];
		}
		if (item.type === "assistant_tool_calls" && item.text) {
			return [{ role: "assistant", content: item.text }];
		}
		return [];
	});
	return Object.freeze({
		...input.config,
		...(input.config.nativeTransport ? { nativeTransport: parseProviderNativeTransportSnapshot(input.config.nativeTransport) } : {}),
		instructions: input.instructions,
		...(input.developerInstructions && input.developerInstructions.length > 0
			? { developerInstructions: Object.freeze([...input.developerInstructions]) }
			: {}),
		messages: Object.freeze(messages),
		items: Object.freeze(items),
		tools: Object.freeze(input.tools.map(copyToolDefinition)),
		...(input.previousResponseId
			? { previousResponseId: input.previousResponseId }
			: {}),
	});
}

export function orderProviderConversationItems(
	items: readonly CanonicalConversationItem[],
): readonly CanonicalConversationItem[] {
	const ordered: CanonicalConversationItem[] = [];
	let pendingCallIds = new Set<string>();
	let deferredContexts: CanonicalConversationItem[] = [];
	const flushContexts = (): void => {
		ordered.push(...deferredContexts);
		deferredContexts = [];
	};

	for (const item of items) {
		if (item.type === "assistant_tool_calls") {
			if (pendingCallIds.size > 0) flushContexts();
			ordered.push(item);
			pendingCallIds = new Set(item.calls.map((call) => call.callId));
			continue;
		}
		if (pendingCallIds.size > 0 && item.type === "context") {
			deferredContexts.push(item);
			continue;
		}
		ordered.push(item);
		if (item.type === "tool_result") {
			pendingCallIds.delete(item.callId);
			if (pendingCallIds.size === 0) flushContexts();
		}
	}
	flushContexts();
	return Object.freeze(ordered);
}

function providerItems(
	input: ProviderRequestProjectionInput,
): readonly CanonicalConversationItem[] {
	if (input.fragments === undefined) return input.history;
	return [
		...(input.fragments.compactedSummary ?? []),
		...(input.fragments.retainedTail ?? []),
		...(input.fragments.rehydration ?? []),
		...(input.fragments.memory ?? []),
		input.fragments.currentInput,
		...(input.fragments.steers ?? []),
	];
}

export function projectNoToolRequest(input: NoToolRequestProjectionInput): ProviderRequest {
	const messages = [
		...input.history.map((message) => ({
			role: message.role,
			content: message.content,
		})),
		{ role: "user" as const, content: input.userText },
	];
	return Object.freeze({
		...input.config,
		...(input.config.nativeTransport ? { nativeTransport: parseProviderNativeTransportSnapshot(input.config.nativeTransport) } : {}),
		instructions: input.instructions,
		...(input.developerInstructions && input.developerInstructions.length > 0
			? { developerInstructions: Object.freeze([...input.developerInstructions]) }
			: {}),
		messages: Object.freeze(messages),
		tools: Object.freeze([]) as readonly [],
	});
}

function copyConversationItem(item: CanonicalConversationItem): CanonicalConversationItem {
	if ((item.type === "user" || item.type === "tool_result") && item.images) {
		return Object.freeze({
			...item,
			images: Object.freeze(item.images.map((image) => Object.freeze({ ...image }))),
		});
	}
	if (item.type === "assistant_tool_calls") {
		return Object.freeze({
			...item,
			calls: Object.freeze(item.calls.map((call) => Object.freeze({ ...call }))),
			...(item.providerState
				? { providerState: copyProviderReplayState(item.providerState) }
				: {}),
		});
	}
	if (item.type === "assistant" && item.providerState) {
		return Object.freeze({
			...item,
			providerState: copyProviderReplayState(item.providerState),
		});
	}
	if (item.type === "context") {
		validateContext(item.text, item.metadata);
		return Object.freeze({
			...item,
			metadata: Object.freeze({ ...item.metadata }),
		});
	}
	return Object.freeze({ ...item });
}

const MAX_CONTEXT_TEXT_CHARS = 131_072;
const MAX_CONTEXT_CONTENT_CHARS = 65_536;
const MAX_CONTEXT_SOURCE_ID_CHARS = 128;

function validateContext(text: string, metadata: CanonicalContextMetadata): void {
	const validSource = metadata.sourceId.length > 0
		&& metadata.sourceId.length <= MAX_CONTEXT_SOURCE_ID_CHARS
		&& !metadata.sourceId.includes("/")
		&& !metadata.sourceId.includes("\\")
		&& !metadata.sourceId.includes("\0");
	if (
		text.length > MAX_CONTEXT_TEXT_CHARS
		|| !CONTEXT_KINDS.has(metadata.kind)
		|| !CONTEXT_CACHE_CLASSES.has(metadata.cacheClass)
		|| metadata.durability !== "persistent"
		|| !CONTEXT_SCOPES.has(metadata.scope)
		|| (metadata.role !== undefined && metadata.role !== "developer" && metadata.role !== "user")
		|| !validSource
		|| !/^[a-f0-9]{64}$/u.test(metadata.contentSha256)
		|| !Number.isSafeInteger(metadata.contentLength)
		|| metadata.contentLength < 0
		|| metadata.contentLength > MAX_CONTEXT_CONTENT_CHARS
		|| (metadata.supersedesItemId !== undefined && !validContextIdentity(metadata.supersedesItemId))
	) {
		throw new TypeError("invalid canonical context metadata");
	}
}

const CONTEXT_KINDS = new Set([
	"collaboration_mode",
	"permissions",
	"tool_exposure",
	"skill_catalog",
	"skill_instructions",
	"workspace_instructions",
	"environment_context",
	"conversation_context",
	"memory",
	"compaction_rehydration",
	"plan",
	"hook_context",
	"runtime_policy_reminder",
	"runtime_context_reminder",
	"subagent_context",
	"turn_aborted",
]);
const CONTEXT_CACHE_CLASSES = new Set(["static", "dynamic", "ephemeral"]);
const CONTEXT_SCOPES = new Set(["session", "turn", "transcript"]);

function validContextIdentity(value: string): boolean {
	return value.length > 0 && value.length <= MAX_CONTEXT_SOURCE_ID_CHARS
		&& !value.includes("/") && !value.includes("\\") && !value.includes("\0");
}

function copyProviderReplayState(state: ProviderReplayState): ProviderReplayState {
	if (state.tokenEstimate !== undefined
		&& (!Number.isSafeInteger(state.tokenEstimate) || state.tokenEstimate < 0)) {
		throw new TypeError("invalid provider replay state");
	}
	let serialized: string;
	try {
		serialized = JSON.stringify(state.value);
	} catch {
		throw new TypeError("invalid provider replay state");
	}
	if (!serialized || serialized.length > PROVIDER_REPLAY_STATE_MAX_JSON_CHARS) {
		throw new TypeError("invalid provider replay state");
	}
	const value = JSON.parse(serialized) as unknown;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("invalid provider replay state");
	}
	return Object.freeze({
		provider: state.provider,
		value: deepFreeze(value as Record<string, unknown>),
		...(state.tokenEstimate === undefined ? {} : { tokenEstimate: state.tokenEstimate }),
	});
}

function deepFreeze<Value>(value: Value): Value {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

function copyToolDefinition(tool: ToolDefinition): ToolDefinition {
	return Object.freeze({
		...tool,
		inputSchema: Object.freeze({ ...tool.inputSchema }),
	});
}
