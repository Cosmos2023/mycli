import type {
	CanonicalToolCall,
	FileMutationPreviewChange,
	ShellLifecycleEvent,
	ToolDefinition,
} from "@mycli/core";
import type { ExecutionPolicy } from "./execution-policy.ts";

export interface ToolEffectProfile {
	readonly filesystem: "none" | "read" | "write";
	readonly network: boolean;
	readonly process: boolean;
}

export interface ToolManifestEntry extends ToolDefinition {
	readonly source: "builtin";
	readonly toolset: string;
	readonly parameters: readonly ToolParameterManifest[];
	readonly risk_level: "low" | "medium" | "high";
	readonly supports_parallel_tool_calls: boolean;
	readonly approval_policy: string;
	readonly capability_tags: readonly string[];
	readonly effects: ToolEffectProfile;
	readonly availability: { readonly status: "available" };
	readonly model_visible: boolean;
}

export type ExtensionToolSource = "mcp" | "plugin" | "skill" | "subagent";

export const EXTENSION_ORIGIN_MAX_ENTRIES = 16;
export const EXTENSION_ORIGIN_MAX_KEY_LENGTH = 64;
export const EXTENSION_ORIGIN_MAX_VALUE_LENGTH = 160;

export interface ManifestToolRegistration {
	readonly id: string;
	readonly source: ExtensionToolSource;
	readonly definition: ToolDefinition;
	readonly originMetadata: Readonly<Record<string, string>>;
	readonly supportsParallelToolCalls: boolean;
}

export interface ExtensionToolManifestEntry extends ToolDefinition {
	readonly source: ExtensionToolSource;
	readonly toolset: "external";
	readonly supports_parallel_tool_calls: boolean;
	readonly availability: { readonly status: "available" };
	readonly origin_metadata: Readonly<Record<string, string>>;
}

export interface ToolParameterManifest {
	readonly name: string;
	readonly type: "string" | "integer" | "number" | "boolean" | "array" | "object";
	readonly required: boolean;
	readonly description?: string;
}

export interface BuiltInToolManifest {
	readonly schema_version: 1;
	readonly source: "builtin";
	readonly toolsets: readonly {
		readonly id: string;
		readonly tool_count: number;
	}[];
	readonly tools: readonly ToolManifestEntry[];
}

export interface CombinedToolManifest {
	readonly schema_version: 1;
	readonly source: "combined";
	readonly toolsets: readonly {
		readonly id: string;
		readonly tool_count: number;
	}[];
	readonly tools: readonly (ToolManifestEntry | ExtensionToolManifestEntry)[];
}

export interface ToolExecutionOptions {
	readonly signal: AbortSignal;
	readonly ownerSessionId: string;
	readonly ownerTurnId?: string;
	readonly callId: string;
	readonly publishLifecycle: (event: ShellLifecycleEvent) => void;
	readonly executionPolicy?: ExecutionPolicy;
	readonly sandboxOverrideApproved?: boolean;
	readonly preparedMutationGuard?: PreparedMutationGuard;
}

export interface ToolPreviewOptions {
	readonly signal: AbortSignal;
	readonly ownerTurnId?: string;
	readonly executionPolicy?: ExecutionPolicy;
	readonly sandboxOverrideApproved?: boolean;
}

export interface PreparedMutationTargetGuard {
	readonly pathSha256: string;
	readonly existed: boolean;
	readonly contentSha256?: string;
	readonly size?: number;
	readonly mtimeNs?: string;
	readonly resultSha256?: string;
}

/**
 * Bounded identity for a prepared mutation preview. It contains no file content
 * or local path and is never part of a provider-visible tool definition. File
 * execution reapplies the canonical request to current filesystem state.
 */
export interface PreparedMutationGuard {
	readonly version: 1;
	readonly mutationId: string;
	readonly intentSha256: string;
	readonly targets: readonly PreparedMutationTargetGuard[];
}

export interface PreparedToolCall {
	readonly fileChanges: readonly FileMutationPreviewChange[];
	readonly mutationGuard?: PreparedMutationGuard;
}

export interface ToolExecutionResult {
	readonly callId: string;
	readonly toolName: string;
	readonly success: boolean;
	readonly modelOutput: string;
	readonly summary: string;
	readonly errorKind?: string;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly planUpdate?: PlanUpdateEffect;
	readonly toolActivation?: ToolActivationEffect;
}

export interface ToolAdapterResult {
	readonly success: boolean;
	readonly modelOutput: string;
	readonly summary: string;
	readonly errorKind?: string;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly planUpdate?: PlanUpdateEffect;
	readonly toolActivation?: ToolActivationEffect;
}

export interface PlanUpdateEffect {
	readonly explanation?: string;
	readonly items: readonly {
		readonly id: string;
		readonly text: string;
		readonly status: "pending" | "in_progress" | "completed";
	}[];
}

export interface ToolActivationEffect {
	readonly names: readonly string[];
}

export interface DeferredToolCandidate {
	readonly definition: ToolDefinition;
	readonly source: "mcp" | "plugin";
	readonly originMetadata: Readonly<Record<string, string>>;
}

export interface ToolAdapter {
	readonly definition: ToolDefinition;
	readonly supportsParallelToolCalls?: boolean;
	beginTurn?(turnId: string): void;
	finishTurn?(turnId: string): void;
	prepare?(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolPreviewOptions,
	): Promise<PreparedToolCall>;
	preview?(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolPreviewOptions,
	): Promise<readonly FileMutationPreviewChange[]>;
	execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult>;
}

export interface ToolRouterContract {
	beginTurn?(turnId: string): void;
	finishTurn?(turnId: string): void;
	supportsParallelToolCalls?(call: CanonicalToolCall, turnId?: string): boolean;
	prepare?(
		call: CanonicalToolCall,
		options: ToolPreviewOptions,
	): Promise<PreparedToolCall>;
	preview?(
		call: CanonicalToolCall,
		options: ToolPreviewOptions,
	): Promise<readonly FileMutationPreviewChange[]>;
	execute(
		call: CanonicalToolCall,
		options: ToolExecutionOptions,
	): Promise<ToolExecutionResult>;
}
