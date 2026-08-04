import type { RuntimeErrorCode } from "@mycli/contracts";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type SessionId = Brand<string, "SessionId">;
export type ClientTurnId = Brand<string, "ClientTurnId">;
export type TurnId = Brand<string, "TurnId">;

export type ProviderId = "openai" | "codex" | "compatible" | "qwen" | "deepseek";
export type ProtocolId = "responses" | "chat_completions";
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

export type CanonicalConversationItem =
	| { readonly type: "user"; readonly text: string }
	| { readonly type: "assistant"; readonly text: string }
	| {
		readonly type: "assistant_tool_calls";
		readonly text: string;
		readonly calls: readonly CanonicalToolCall[];
		readonly responseId?: string;
	}
	| ({ readonly type: "tool_result" } & CanonicalToolResult);

export interface ProviderRequestConfig {
	readonly provider: ProviderId;
	readonly protocol: ProtocolId;
	readonly model: string;
	readonly reasoningEffort?: ReasoningEffort;
	readonly maxOutputTokens?: number;
	readonly promptCacheKey?: string;
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
	| { readonly type: "usage"; readonly usage: ProviderUsage }
	| { readonly type: "completed"; readonly responseId?: string }
	| {
		readonly type: "tool_call";
		readonly callId?: string;
		readonly name: string;
		readonly argumentsJson: string;
	};

export type RuntimeEvent =
	| { readonly type: "turn_started"; readonly clientTurnId: string; readonly turnId: string }
	| { readonly type: "reasoning_delta"; readonly text: string }
	| { readonly type: "text_delta"; readonly text: string }
	| { readonly type: "stream_retrying"; readonly attempt: number; readonly delayMs: number }
	| { readonly type: "stream_recovered" }
	| { readonly type: "message_complete"; readonly responseId?: string }
	| { readonly type: "turn_completed"; readonly assistantText: string; readonly usage: ProviderUsage }
	| { readonly type: "turn_failed"; readonly code: RuntimeErrorCode; readonly message: string }
	| { readonly type: "turn_interrupted"; readonly message: string };

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
