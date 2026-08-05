import type { RuntimeErrorCode } from "@mycli/contracts";
import type { ShellLifecycleEvent } from "./shell-lifecycle.ts";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type SessionId = Brand<string, "SessionId">;
export type ClientTurnId = Brand<string, "ClientTurnId">;
export type TurnId = Brand<string, "TurnId">;

export type ProviderId = "openai" | "codex" | "compatible" | "qwen" | "deepseek" | "anthropic";
export type ProtocolId = "responses" | "chat_completions" | "anthropic_messages";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type TurnStatus = "in_progress" | "completed" | "failed" | "interrupted";

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

export interface CanonicalImage {
	readonly mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
	readonly data: string;
}

export interface ProviderReplayState {
	readonly provider: ProviderId;
	readonly value: Readonly<Record<string, unknown>>;
}

export interface CanonicalContextMetadata {
	readonly kind: "skill_instructions";
	readonly cacheClass: "dynamic";
	readonly durability: "persistent";
	readonly scope: "transcript";
	readonly sourceId: string;
	readonly contentSha256: string;
	readonly contentLength: number;
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
	readonly promptCacheKey?: string;
	readonly cacheControlEnabled?: boolean;
}

export interface ProviderRequest extends ProviderRequestConfig {
	readonly instructions: string;
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
		readonly type: "compaction_started";
		readonly clientTurnId: string;
		readonly source: "pre_turn" | "context_overflow";
		readonly beforeTokens: number;
		readonly maxTokens: number;
	}
	| {
		readonly type: "compaction_completed";
		readonly clientTurnId: string;
		readonly source: "pre_turn" | "context_overflow";
		readonly status: "compressed" | "skipped";
		readonly beforeTokens: number;
		readonly afterTokens: number;
		readonly maxTokens: number;
		readonly durationSeconds: number;
	}
	| { readonly type: "reasoning_delta"; readonly text: string }
	| { readonly type: "text_delta"; readonly text: string }
	| { readonly type: "stream_retrying"; readonly attempt: number; readonly delayMs: number }
	| { readonly type: "stream_recovered" }
	| { readonly type: "message_complete"; readonly responseId?: string }
	| { readonly type: "tool_call_accepted"; readonly callId: string; readonly toolName: string }
	| {
		readonly type: "approval_requested";
		readonly clientTurnId: string;
		readonly turnId: string;
		readonly decisionId: string;
		readonly callId: string;
		readonly toolName: string;
		readonly preview: string;
		readonly reason: string;
		readonly options: readonly ApprovalChoice[];
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
