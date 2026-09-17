import { NODE_RUNTIME_CONTEXT_DEFAULTS } from "@mycli/config";
import type { CanonicalConversationItem } from "@mycli/core";
import { ProviderFailure } from "@mycli/providers";
import type { TokenCounter } from "./token-counter.ts";

const COMPACTION_USER_MESSAGE_MAX_TOKENS = NODE_RUNTIME_CONTEXT_DEFAULTS.compactionTailMaxTokens;
export const COMPACTION_SUMMARY_PREFIX = "[compact-summary]\n";

export function compactionSummaryInstruction(): string {
	return `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;
}

export function compactionSummaryHistory(
	items: readonly CanonicalConversationItem[],
	instruction: string,
): readonly CanonicalConversationItem[] {
	return [...items, { type: "user", text: instruction }];
}

export function assertCompactionSummary(summary: string): void {
	if (!summary.trim()) {
		throw new ProviderFailure({ code: "provider_error", message: "compaction summary provider returned empty text",
			publicDetail: "The provider returned no compaction summary.", errorReason: { reason: "provider.empty_response" } });
	}
}

export function compactionSummaryItem(summary: string): Extract<CanonicalConversationItem, { readonly type: "user" }> {
	return {
		type: "user",
		text: COMPACTION_SUMMARY_PREFIX
			+ "Another language model started to solve this problem and produced a summary of its thinking process. "
			+ "You also have access to the state of the tools that were used by that language model. "
			+ "Use this to build on the work that has already been done and avoid duplicating work. "
			+ "Here is the summary produced by the other language model, use this information to assist with your own analysis:\n\n"
			+ summary,
	};
}

// Trim only the request snapshot. A grouped tool call and its results must remain paired.
export function removeOldestCompactionItem(
	items: readonly CanonicalConversationItem[],
): readonly CanonicalConversationItem[] {
	const [removed, ...remaining] = items;
	if (removed?.type === "assistant_tool_calls") {
		const callIds = new Set(removed.calls.map((call) => call.callId));
		return remaining.filter((item) => item.type !== "tool_result" || !callIds.has(item.callId));
	}
	if (removed?.type === "tool_result") {
		return remaining.flatMap((item): CanonicalConversationItem[] => {
			if (item.type !== "assistant_tool_calls") return [item];
			const calls = item.calls.filter((call) => call.callId !== removed.callId);
			return calls.length ? [{ ...item, calls }] : [];
		});
	}
	return remaining;
}

export function retainCompactionUserMessages(
	items: readonly CanonicalConversationItem[],
	counter: TokenCounter,
	maxTokens = COMPACTION_USER_MESSAGE_MAX_TOKENS,
): readonly CanonicalConversationItem[] {
	let remaining = maxTokens;
	const retained: CanonicalConversationItem[] = [];
	for (const item of items.toReversed()) {
		if (remaining <= 0) break;
		if (item.type !== "user" || !item.text.trim() || item.text.startsWith(COMPACTION_SUMMARY_PREFIX)) continue;
		const tokens = counter.count(item.text);
		if (tokens <= remaining) {
			// Old images and tool artifacts are represented by the summary; retain user text.
			retained.push({ type: "user", text: item.text });
			remaining -= tokens;
		} else {
			const text = truncateUserMessage(item.text, remaining, counter);
			if (text) retained.push({ type: "user", text });
			break;
		}
	}
	return retained.reverse();
}

function truncateUserMessage(text: string, maxTokens: number, counter: TokenCounter): string | undefined {
	const marker = "\n[... truncated during compaction ...]\n";
	if (counter.count(marker) > maxTokens) return undefined;
	const characters = Array.from(text);
	let low = 0;
	let high = characters.length;
	let bounded = marker;
	while (low <= high) {
		const keep = Math.floor((low + high) / 2);
		const head = Math.ceil(keep / 2);
		const tail = Math.floor(keep / 2);
		const candidate = characters.slice(0, head).join("") + marker
			+ (tail ? characters.slice(-tail).join("") : "");
		if (counter.count(candidate) <= maxTokens) {
			bounded = candidate;
			low = keep + 1;
		} else high = keep - 1;
	}
	return bounded;
}
