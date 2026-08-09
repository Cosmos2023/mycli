import type {
	CanonicalToolCall,
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
}

export interface ExtensionToolManifestEntry extends ToolDefinition {
	readonly source: ExtensionToolSource;
	readonly toolset: "external";
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
}

export interface ToolExecutionResult {
	readonly callId: string;
	readonly toolName: string;
	readonly success: boolean;
	readonly modelOutput: string;
	readonly summary: string;
	readonly errorKind?: string;
	readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ToolAdapterResult {
	readonly success: boolean;
	readonly modelOutput: string;
	readonly summary: string;
	readonly errorKind?: string;
	readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ToolAdapter {
	readonly definition: ToolDefinition;
	execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult>;
}

export interface ToolRouterContract {
	execute(
		call: CanonicalToolCall,
		options: ToolExecutionOptions,
	): Promise<ToolExecutionResult>;
}
