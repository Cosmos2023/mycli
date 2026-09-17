import type { CanonicalConversationItem, ProviderReplayState } from "@mycli/core";
import type { TokenCounter } from "./token-counter.ts";

export function countConversationTokens(counter: TokenCounter, items: readonly CanonicalConversationItem[]): number {
	return items.reduce((total, item) => {
		const providerState = item.type === "assistant" || item.type === "assistant_tool_calls"
			? item.providerState
			: undefined;
		return total + counter.count(renderConversationItem(item))
			+ (providerState ? countProviderReplayState(counter, providerState) : 0);
	}, 0);
}

const OPAQUE_PROVIDER_STATE_KEYS = new Set([
	"encrypted_content",
	"encryptedContent",
	"signature",
]);

function countProviderReplayState(counter: TokenCounter, state: ProviderReplayState): number {
	if (state.tokenEstimate !== undefined
		&& Number.isSafeInteger(state.tokenEstimate)
		&& state.tokenEstimate >= 0) {
		return state.tokenEstimate;
	}
	return counter.count(JSON.stringify(withoutOpaqueProviderState(state.value)));
}

function withoutOpaqueProviderState(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutOpaqueProviderState);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => (
		OPAQUE_PROVIDER_STATE_KEYS.has(key)
			? []
			: [[key, withoutOpaqueProviderState(entry)]]
	)));
}

export function renderConversationItem(item: CanonicalConversationItem): string {
	switch (item.type) {
		case "user":
		case "assistant":
			return `${item.type}: ${item.text}`;
		case "context":
			return `context ${item.metadata.kind}: ${item.text}`;
		case "assistant_tool_calls":
			return `assistant: ${item.text}\n${item.calls.map((call) =>
				`tool_call ${call.name} ${call.callId} ${call.argumentsJson}`).join("\n")}`;
		case "tool_result":
			return `tool ${item.toolName} ${item.callId}: ${item.output}`;
	}
}
