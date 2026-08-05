import type {
	CanonicalConversationItem,
	CanonicalMessage,
	ProviderRequest,
	ProviderRequestConfig,
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
	if (item.type === "assistant_tool_calls") {
		return Object.freeze({
			...item,
			calls: Object.freeze(item.calls.map((call) => Object.freeze({ ...call }))),
		});
	}
	return Object.freeze({ ...item });
}

function copyToolDefinition(tool: ToolDefinition): ToolDefinition {
	return Object.freeze({
		...tool,
		inputSchema: Object.freeze({ ...tool.inputSchema }),
	});
}
