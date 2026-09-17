import type { CanonicalImage } from "@mycli/core";

export interface TrainingReasoningBlock {
	readonly kind: "thinking" | "summary";
	readonly text: string;
}

export interface TrainingToolCall {
	readonly id: string;
	readonly type: "function";
	readonly function: { readonly name: string; readonly arguments: string };
}

export type TrainingMessage =
	| { readonly role: "system" | "developer" | "user"; readonly content: string; readonly images?: readonly CanonicalImage[] }
	| { readonly role: "assistant"; readonly content: string; readonly tool_calls?: readonly TrainingToolCall[];
		readonly reasoning?: readonly TrainingReasoningBlock[]; readonly native_activity?: readonly Readonly<Record<string, unknown>>[] }
	| { readonly role: "tool"; readonly tool_call_id: string; readonly content: string;
		readonly is_error?: true; readonly images?: readonly CanonicalImage[] };

export interface TrainingToolDefinition {
	readonly type: "function";
	readonly function: {
		readonly name: string;
		readonly description: string;
		readonly parameters: Readonly<Record<string, unknown>>;
	};
}

/** One JSONL row for the whole session; conversation prefixes are never repeated. */
export interface SessionTrainingConversation {
	readonly schema_version: 3;
	readonly source: { readonly session_id: string };
	readonly messages: readonly TrainingMessage[];
	readonly tools: readonly TrainingToolDefinition[];
}

export type TrainingExportWarning = "initial_context_unavailable" | "legacy_content_unavailable";

export interface SessionTrainingExportReport {
	readonly schema_version: 3;
	readonly turns: number;
	readonly messages: number;
	readonly tool_calls: number;
	readonly tool_results: number;
	readonly reasoning_blocks: number;
	readonly images: number;
	readonly warnings: readonly TrainingExportWarning[];
	readonly redactions: number;
	readonly bytes_written: number;
}
