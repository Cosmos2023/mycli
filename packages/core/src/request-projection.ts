import type {
	CanonicalConversationItem,
	CanonicalContextMetadata,
	CanonicalMessage,
	ProviderRequest,
	ProviderRequestConfig,
	ProviderReplayState,
	ToolDefinition,
} from "./types.ts";

export interface NoToolRequestProjectionInput {
	readonly config: ProviderRequestConfig;
	readonly instructions: string;
	readonly history: readonly CanonicalMessage[];
	readonly userText: string;
}

interface ProviderRequestProjectionBase {
	readonly config: ProviderRequestConfig;
	readonly instructions: string;
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
	const items = providerItems(input).map(copyConversationItem);
	const messages = items.flatMap((item): CanonicalMessage[] => {
		if (item.type === "user") {
			return [{ role: "user", content: item.text }];
		}
		if (item.type === "assistant") {
			return [{ role: "assistant", content: item.text }];
		}
		return [];
	});
	return Object.freeze({
		...input.config,
		instructions: input.instructions,
		messages: Object.freeze(messages),
		items: Object.freeze(items),
		tools: Object.freeze(input.tools.map(copyToolDefinition)),
		...(input.previousResponseId
			? { previousResponseId: input.previousResponseId }
			: {}),
	});
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
		instructions: input.instructions,
		messages: Object.freeze(messages),
		tools: Object.freeze([]) as readonly [],
	});
}

function copyConversationItem(item: CanonicalConversationItem): CanonicalConversationItem {
	if (item.type === "user" && item.images) {
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
const MAX_PROVIDER_STATE_JSON_CHARS = 65_536;

function validateContext(text: string, metadata: CanonicalContextMetadata): void {
	const validSource = metadata.sourceId.length > 0
		&& metadata.sourceId.length <= MAX_CONTEXT_SOURCE_ID_CHARS
		&& !metadata.sourceId.includes("/")
		&& !metadata.sourceId.includes("\\")
		&& !metadata.sourceId.includes("\0");
	if (
		text.length > MAX_CONTEXT_TEXT_CHARS
		|| metadata.kind !== "skill_instructions"
		|| metadata.cacheClass !== "dynamic"
		|| metadata.durability !== "persistent"
		|| metadata.scope !== "transcript"
		|| !validSource
		|| !/^[a-f0-9]{64}$/u.test(metadata.contentSha256)
		|| !Number.isSafeInteger(metadata.contentLength)
		|| metadata.contentLength < 0
		|| metadata.contentLength > MAX_CONTEXT_CONTENT_CHARS
	) {
		throw new TypeError("invalid canonical context metadata");
	}
}

function copyProviderReplayState(state: ProviderReplayState): ProviderReplayState {
	let serialized: string;
	try {
		serialized = JSON.stringify(state.value);
	} catch {
		throw new TypeError("invalid provider replay state");
	}
	if (!serialized || serialized.length > MAX_PROVIDER_STATE_JSON_CHARS) {
		throw new TypeError("invalid provider replay state");
	}
	const value = JSON.parse(serialized) as unknown;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("invalid provider replay state");
	}
	return Object.freeze({
		provider: state.provider,
		value: deepFreeze(value as Record<string, unknown>),
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
