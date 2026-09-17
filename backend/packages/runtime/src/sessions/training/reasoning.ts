import type { ProviderReplayState } from "@mycli/core";
import { isRecord } from "./redaction.ts";
import type { TrainingRedactor } from "./redaction.ts";
import type { TrainingReasoningBlock } from "./types.ts";

/** Read only known plaintext fields. Signatures and encrypted blocks are not reasoning text. */
export function trainingReasoning(state: ProviderReplayState | undefined, redactor: TrainingRedactor): readonly TrainingReasoningBlock[] {
	if (!state) return [];
	const value = state.value;
	if (Array.isArray(value.thinkingBlocks)) {
		const summary = isRecord(value.transport) && typeof value.transport.api === "string" && value.transport.api.endsWith("responses");
		return value.thinkingBlocks.flatMap((block): TrainingReasoningBlock[] =>
			isRecord(block) && block.redacted !== true && block.type !== "redacted_thinking"
				&& typeof block.thinking === "string" && block.thinking.length > 0
				? [{ kind: summary ? "summary" : "thinking", text: redactor.text(block.thinking) }] : []);
	}
	if (typeof value.reasoningContent === "string" && value.reasoningContent.length > 0) {
		return [{ kind: "thinking", text: redactor.text(value.reasoningContent) }];
	}
	const native = value.responsesNativeItems ?? value.responsesReasoningItems;
	if (!Array.isArray(native)) return [];
	return native.flatMap((item): TrainingReasoningBlock[] =>
		isRecord(item) && item.type === "reasoning" && Array.isArray(item.summary)
			? item.summary.flatMap((part): TrainingReasoningBlock[] =>
				isRecord(part) && part.type === "summary_text" && typeof part.text === "string" && part.text.length > 0
					? [{ kind: "summary", text: redactor.text(part.text) }] : []) : []);
}
