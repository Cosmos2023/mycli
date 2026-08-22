import type { RuntimeErrorCode } from "@mycli/contracts";
import type { ShellLifecycleEvent } from "./shell-lifecycle.ts";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type SessionId = Brand<string, "SessionId">;
export type ClientTurnId = Brand<string, "ClientTurnId">;
export type TurnId = Brand<string, "TurnId">;

export type ProviderId = "openai" | "codex" | "compatible" | "qwen" | "deepseek" | "anthropic";
export type ProtocolId = "responses" | "chat_completions" | "anthropic_messages";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type TurnStatus = "in_progress" | "completed" | "failed" | "interrupted";

export const PROVIDER_REPLAY_STATE_MAX_JSON_CHARS = 1_048_576;

export interface CanonicalMessage {
	readonly role: "user" | "assistant";
	readonly content: string;
}

export interface ToolDefinition {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface CanonicalToolCall {
	readonly callId: string;
	readonly name: string;
	readonly argumentsJson: string;
}

export interface CanonicalToolResult {
	readonly callId: string;
	readonly toolName: string;
	readonly output: string;
	readonly success: boolean;
}

export interface ApprovalPreviewDetails {
	readonly contentPreview?: string;
	readonly contentLineCount?: number;
	readonly contentChars?: number;
	readonly contentTruncated?: boolean;
	readonly diff?: string;
	readonly diffChars?: number;
	readonly diffTruncated?: boolean;
}

export interface FileMutationPreviewChange {
	readonly version: 1;
	readonly kind: "add" | "update" | "delete" | "move";
	readonly path: string;
	readonly previousPath?: string;
	readonly diff: string;
	readonly addedLines: number;
	readonly removedLines: number;
	readonly truncated: boolean;
	readonly omittedChars: number;
}

export interface CanonicalImage {
	readonly mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
	readonly data: string;
}

export interface ProviderReplayState {
	readonly provider: ProviderId;
	readonly value: Readonly<Record<string, unknown>>;
	readonly tokenEstimate?: number;
}

export type CanonicalContextKind =
	| "collaboration_mode"
	| "permissions"
	| "tool_exposure"
	| "skill_catalog"
	| "skill_instructions"
	| "workspace_instructions"
	| "environment_context"
	| "conversation_context"
	| "memory"
	| "compaction_rehydration"
	| "plan"
	| "hook_context"
	| "runtime_policy_reminder"
	| "runtime_context_reminder"
	| "subagent_context"
	| "turn_aborted";

export interface CanonicalContextMetadata {
	readonly kind: CanonicalContextKind;
	readonly role?: "developer" | "user";
	readonly cacheClass: "static" | "dynamic" | "ephemeral";
	readonly durability: "persistent";
	readonly scope: "session" | "turn" | "transcript";
	readonly sourceId: string;
	readonly contentSha256: string;
	readonly contentLength: number;
	readonly supersedesItemId?: string;
	readonly tombstone?: boolean;
}

export type CanonicalConversationItem =
	| {
		readonly type: "user";
		readonly text: string;
		readonly images?: readonly CanonicalImage[];
	}
	| {
		readonly type: "assistant";
		readonly text: string;
		readonly providerState?: ProviderReplayState;
	}
	| {
		readonly type: "assistant_tool_calls";
		readonly text: string;
		readonly calls: readonly CanonicalToolCall[];
		readonly responseId?: string;
		readonly providerState?: ProviderReplayState;
	}
	| {
		readonly type: "context";
		readonly text: string;
		readonly metadata: CanonicalContextMetadata;
	}
	| ({ readonly type: "tool_result" } & CanonicalToolResult);

export interface ProviderRequestConfig {
	readonly provider: ProviderId;
	readonly protocol: ProtocolId;
	readonly model: string;
	readonly reasoningEffort?: ReasoningEffort;
	readonly maxOutputTokens?: number;
	readonly store?: boolean;
	readonly promptCacheKey?: string;
	readonly cacheControlEnabled?: boolean;
}

export interface ProviderRequest extends ProviderRequestConfig {
	readonly instructions: string;
	readonly developerInstructions?: readonly string[];
	readonly messages: readonly CanonicalMessage[];
	readonly items?: readonly CanonicalConversationItem[];
	readonly tools: readonly ToolDefinition[];
	readonly previousResponseId?: string;
}

export type ProviderUsage = Readonly<Record<string, number>>;

export type ProviderEvent =
	| { readonly type: "reasoning_delta"; readonly text: string }
	| { readonly type: "text_delta"; readonly text: string }
	| { readonly type: "provider_state"; readonly state: ProviderReplayState }
	| { readonly type: "usage"; readonly usage: ProviderUsage }
	| { readonly type: "completed"; readonly responseId?: string }
	| {
		readonly type: "tool_call";
		readonly callId: string;
		readonly name: string;
		readonly argumentsJson: string;
	};

export type RuntimeEvent =
	| ShellLifecycleEvent
	| { readonly type: "turn_started"; readonly clientTurnId: string; readonly turnId: string }
	| {
		readonly type: "user_message_started" | "user_message_completed";
		readonly clientTurnId: string;
		readonly turnId: string;
		readonly itemId: string;
		readonly clientUserMessageId: string;
		readonly content: string;
		readonly source: "submit" | "steer";
	}
	| {
		readonly type: "compaction_started";
		readonly clientTurnId: string;
		readonly source: "pre_turn" | "mid_turn" | "context_overflow" | "user_requested";
		readonly beforeTokens: number;
		readonly maxTokens: number;
	}
	| {
		readonly type: "compaction_completed";
		readonly clientTurnId: string;
		readonly source: "pre_turn" | "mid_turn" | "context_overflow" | "user_requested";
		readonly status: "compressed" | "skipped" | "failed";
		readonly beforeTokens: number;
		readonly afterTokens: number;
		readonly maxTokens: number;
		readonly durationSeconds: number;
	}
	| { readonly type: "reasoning_delta"; readonly text: string }
	| { readonly type: "text_delta"; readonly text: string }
	| { readonly type: "provider_usage"; readonly usage: ProviderUsage }
	| { readonly type: "stream_retrying"; readonly attempt: number; readonly delayMs: number }
	| { readonly type: "stream_recovered" }
	| { readonly type: "message_complete"; readonly responseId?: string }
	| { readonly type: "tool_call_accepted"; readonly callId: string; readonly toolName: string }
	| (ApprovalPreviewDetails & {
			readonly type: "file_mutation_started";
			readonly clientTurnId: string;
			readonly turnId: string;
			readonly callId: string;
			readonly toolName: string;
			readonly preview: string;
			readonly fileChanges?: readonly FileMutationPreviewChange[];
		})
	| (ApprovalPreviewDetails & {
		readonly type: "approval_requested";
		readonly clientTurnId: string;
		readonly turnId: string;
		readonly decisionId: string;
		readonly callId: string;
		readonly toolName: string;
		readonly preview: string;
		readonly reason: string;
		readonly options: readonly ApprovalChoice[];
	})
	| {
		readonly type: "clarification_requested";
		readonly clientTurnId: string;
		readonly turnId: string;
		readonly requestId: string;
		readonly callId: string;
		readonly toolName: string;
		readonly question: string;
		readonly options: readonly {
			readonly label: string;
			readonly description?: string;
		}[];
		readonly header: string;
		readonly multiSelect: boolean;
	}
	| { readonly type: "tool_execution_started"; readonly callId: string; readonly toolName: string }
	| {
		readonly type: "tool_execution_completed";
		readonly callId: string;
		readonly toolName: string;
		readonly summary: string;
		readonly durationMs: number;
		readonly metadata: Readonly<Record<string, unknown>>;
	}
	| {
		readonly type: "tool_execution_failed";
		readonly callId: string;
		readonly toolName: string;
		readonly summary: string;
		readonly durationMs: number;
		readonly errorKind?: string;
		readonly metadata: Readonly<Record<string, unknown>>;
	}
	| {
		readonly type: "plan_updated";
		readonly explanation?: string;
		readonly items: readonly {
			readonly id: string;
			readonly text: string;
			readonly status: "pending" | "in_progress" | "completed";
		}[];
	}
	| { readonly type: "turn_completed"; readonly assistantText: string; readonly usage: ProviderUsage }
	| { readonly type: "turn_failed"; readonly code: RuntimeErrorCode; readonly message: string }
	| { readonly type: "turn_interrupted"; readonly message: string };

export type ApprovalChoice =
	| "approve_once"
	| "reject"
	| "allow_session"
	| "always_allow";

export type ExecPolicyDecision = "allow" | "ask" | "deny";
export type ExecPolicySource = "user" | "project" | "session";

export interface ExecPolicyRule {
	readonly source: ExecPolicySource;
	readonly index: number;
	readonly pattern: readonly string[];
	readonly decision: ExecPolicyDecision;
}

export interface TurnSnapshot {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly turnId: string;
	readonly status: TurnStatus;
	readonly startedAt: string;
	readonly completedAt?: string;
	readonly assistantText?: string;
	readonly usage?: ProviderUsage;
	readonly errorCode?: RuntimeErrorCode;
	readonly errorMessage?: string;
}

export type { RuntimeErrorCode };
