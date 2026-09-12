import type { ErrorContext, GatewayTerminalInteraction, ProviderAttemptRecord, RuntimeErrorCode, RuntimeFailure } from "@mycli/contracts";
import type { ShellLifecycleEvent } from "./lifecycle/shell-lifecycle.ts";
import type { ProviderNativeTransportSnapshot } from "./conversation/provider-native-transport.ts";
import type { ToolDiscovery } from "./conversation/tool-discovery.ts";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type SessionId = Brand<string, "SessionId">;
export type ClientTurnId = Brand<string, "ClientTurnId">;
export type TurnId = Brand<string, "TurnId">;

export const PROVIDER_IDS = Object.freeze([
	"openai",
	"codex",
	"deepseek",
	"qwen",
	"anthropic",
	"openrouter",
	"groq",
	"together",
	"moonshotai",
	"nvidia",
	"cerebras",
	"compatible",
] as const);

export type ProviderId = typeof PROVIDER_IDS[number];
export const PROVIDER_ROUTE_ID_MAX_CHARS = 64;

export type ProviderRouteId = ProviderId | Brand<string, "ProviderRouteId">;
export type ProtocolId = "responses" | "chat_completions" | "anthropic_messages";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type CacheRetention = "none" | "short" | "long";
export type WebSearchMode = "live" | "disabled";
export type TurnStatus = "in_progress" | "completed" | "failed" | "interrupted";

export const PROVIDER_REPLAY_STATE_MAX_JSON_CHARS = 1_048_576;

const PROVIDER_ID_SET = new Set<string>(PROVIDER_IDS);
const PROVIDER_ROUTE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

export function isProviderId(value: unknown): value is ProviderId {
	return typeof value === "string" && PROVIDER_ID_SET.has(value);
}

export function isProviderRouteId(value: unknown): value is ProviderRouteId {
	return typeof value === "string"
		&& value.length <= PROVIDER_ROUTE_ID_MAX_CHARS
		&& PROVIDER_ROUTE_ID_PATTERN.test(value);
}

export function parseProviderRouteId(value: unknown): ProviderRouteId {
	if (!isProviderRouteId(value)) {
		throw new TypeError(
			`provider route id must start with a lowercase ASCII letter, contain only lowercase ASCII letters, digits, or internal hyphens, and be at most ${PROVIDER_ROUTE_ID_MAX_CHARS} characters`,
		);
	}
	return value as ProviderRouteId;
}

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
	readonly images?: readonly CanonicalImage[];
	/** Validated load points; schemas are resolved from the current authorized request. */
	readonly toolDiscoveries?: readonly ToolDiscovery[];
}

export interface ApprovalPreviewDetails {
	readonly commandPreview?: string;
	readonly commandTruncated?: boolean;
	readonly justification?: string;
	readonly contentPreview?: string;
	readonly contentLineCount?: number;
	readonly contentChars?: number;
	readonly contentTruncated?: boolean;
	readonly diff?: string;
	readonly diffChars?: number;
	readonly diffTruncated?: boolean;
}

export type PermissionGrantScope = "turn" | "session";

export interface PermissionRequestProfile {
	readonly network?: {
		readonly enabled: true;
	};
	readonly fileSystem?: {
		readonly read: readonly string[];
		readonly write: readonly string[];
	};
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
	readonly detail?: "high" | "original";
}

export interface ProviderReplayState {
	readonly provider: ProviderRouteId;
	readonly value: Readonly<Record<string, unknown>>;
	readonly tokenEstimate?: number;
}

export type WebSearchAction =
	| {
		readonly type: "search";
		readonly query?: string;
		readonly queries?: readonly string[];
	}
	| { readonly type: "open_page"; readonly url?: string }
	| { readonly type: "find_in_page"; readonly url?: string; readonly pattern?: string }
	| { readonly type: "other" };

export interface WebSearchCall {
	readonly callId: string;
	readonly action: WebSearchAction;
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
	readonly provider: ProviderRouteId;
	readonly protocol: ProtocolId;
	readonly model: string;
	readonly nativeTransport?: ProviderNativeTransportSnapshot;
	readonly reasoningEffort?: ReasoningEffort;
	readonly maxOutputTokens?: number;
	readonly sessionId?: string;
	readonly cacheRetention?: CacheRetention;
	readonly webSearchMode?: WebSearchMode;
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
	| { readonly type: "web_search_started"; readonly callId: string }
	| { readonly type: "web_search_completed"; readonly call: WebSearchCall }
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
		readonly failure?: RuntimeFailure;
		readonly usage?: ProviderUsage;
		readonly clientTurnId: string;
		readonly source: "pre_turn" | "mid_turn" | "context_overflow" | "user_requested";
		readonly status: "compressed" | "skipped" | "failed";
		readonly beforeTokens: number;
		readonly afterTokens: number;
		readonly maxTokens: number;
		readonly durationSeconds: number;
	}
	| {
		readonly type: "compaction_progress";
		readonly clientTurnId: string;
		readonly operationId: string;
		readonly text: string;
	}
	| { readonly type: "reasoning_delta"; readonly text: string }
	| { readonly type: "text_delta"; readonly text: string }
	| { readonly type: "provider_usage"; readonly usage: ProviderUsage }
	| {
		readonly type: "stream_retrying";
		readonly attempt: number;
		readonly maxRetries: number;
		readonly delayMs: number;
		readonly recoveryKind: "request" | "stream";
		readonly resetOutput: boolean;
		readonly failureKind: RuntimeErrorCode;
		readonly additionalDetails: string;
	}
	| { readonly type: "stream_recovered" }
	| { readonly type: "provider_attempt"; readonly record: ProviderAttemptRecord }
	| { readonly type: "message_complete"; readonly responseId?: string }
	| { readonly type: "web_search_started"; readonly callId: string }
	| { readonly type: "web_search_completed"; readonly call: WebSearchCall }
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
		readonly permissionRequest?: PermissionRequestProfile;
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
	| { readonly type: "tool_execution_started"; readonly callId: string; readonly toolName: string;
		readonly terminalInteraction?: GatewayTerminalInteraction }
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
	| {
		readonly type: "turn_completed";
		readonly assistantText: string;
		readonly usage: ProviderUsage;
		readonly durationMs?: number;
	}
	| {
		readonly type: "runtime_error";
		readonly code: RuntimeErrorCode;
		readonly message: string;
		readonly errorContext?: ErrorContext;
	}
	| {
		readonly type: "turn_failed";
		readonly code: RuntimeErrorCode;
		readonly message: string;
		readonly additionalDetails?: string;
		readonly errorContext?: ErrorContext;
	}
	| { readonly type: "turn_interrupted"; readonly message: string; readonly errorContext?: ErrorContext };

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
