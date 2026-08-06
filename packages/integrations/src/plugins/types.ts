import type {
	PluginV2Manifest,
	PluginV2ProtocolMessage,
} from "@mycli/contracts";
import type { HookPoint } from "@mycli/core";

export type PluginSource = "repo" | "user";
export type PluginDiagnosticSource = PluginSource | "legacy_user" | "discovery";

export interface PluginDiagnostic {
	readonly source: PluginDiagnosticSource;
	readonly pluginId: string;
	readonly fileLabel: string;
	readonly errorClass: string;
}

export type LoadedPluginManifest = PluginV2Manifest & {
	readonly source: PluginSource;
	readonly pluginRoot: string;
	readonly manifestPath: string;
	readonly entryPath: string;
};

export type PluginManifestLoadResult =
	| { readonly kind: "loaded"; readonly manifest: LoadedPluginManifest }
	| { readonly kind: "invalid"; readonly diagnostic: PluginDiagnostic };

interface PluginCandidateBase {
	readonly pluginId: string;
	readonly source: PluginSource;
	readonly enabled: boolean;
	readonly duplicate: boolean;
}

export interface DiscoveredPlugin extends PluginCandidateBase {
	readonly kind: "plugin";
	readonly manifest: LoadedPluginManifest;
}

export interface PluginMigrationDiagnostic extends PluginCandidateBase {
	readonly kind: "migration_required";
	readonly message: "Python plugin requires Plugin API v2 migration";
}

export interface InvalidPluginCandidate extends PluginCandidateBase {
	readonly kind: "invalid";
	readonly diagnostic: PluginDiagnostic;
}

export type PluginCandidate =
	| DiscoveredPlugin
	| PluginMigrationDiagnostic
	| InvalidPluginCandidate;

export interface PluginEnablement {
	readonly enabledIds: readonly string[];
	readonly disabledIds: readonly string[];
	readonly issues: readonly PluginDiagnostic[];
	isEnabled(pluginId: string): boolean;
}

export interface PluginDiscovery {
	readonly candidates: readonly PluginCandidate[];
	readonly selected: readonly PluginCandidate[];
	readonly plugins: readonly DiscoveredPlugin[];
	readonly migrations: readonly PluginMigrationDiagnostic[];
	readonly diagnostics: readonly PluginDiagnostic[];
	readonly enablement: PluginEnablement;
	get(pluginId: string): PluginCandidate | undefined;
}

export type PluginProtocolRegistration = Extract<
	PluginV2ProtocolMessage,
	{ readonly type: "registered" }
>["registrations"][number];

export type PluginResultType = "tool_result" | "hook_result" | "command_result";
export type PluginHostStatus = "idle" | "starting" | "ready" | "closing" | "closed" | "failed";

export type PluginHostErrorKind =
	| "call_timeout"
	| "handler_failed"
	| "host_closed"
	| "input_too_large"
	| "missing_required_env"
	| "plugin_error"
	| "protocol_invalid"
	| "registration_mismatch"
	| "sandbox_unavailable"
	| "spawn_failed"
	| "startup_timeout"
	| "stderr_limit_exceeded"
	| "stdout_limit_exceeded"
	| "too_many_requests"
	| "unknown_response_id"
	| "unknown_target"
	| "worker_exited";

export interface PluginInvocationResult {
	readonly ok: true;
	readonly resultType: PluginResultType;
	readonly value: Readonly<Record<string, unknown>>;
}

export interface PluginHostContract {
	readonly status: PluginHostStatus;
	readonly registrations: readonly PluginProtocolRegistration[];
	start(signal: AbortSignal): Promise<readonly PluginProtocolRegistration[]>;
	invoke(
		target: string,
		input: Readonly<Record<string, unknown>>,
		signal: AbortSignal,
	): Promise<PluginInvocationResult>;
	close(): Promise<void>;
}

export type PluginHandler = (
	input: Readonly<Record<string, unknown>>,
	signal: AbortSignal,
) => unknown | Promise<unknown>;

export interface PluginToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface PluginHookDefinition {
	readonly name: string;
	readonly hookPoint: HookPoint;
}

export interface PluginCommandDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface PluginContextV2 {
	registerTool(definition: PluginToolDefinition, handler: PluginHandler): void;
	registerHook(definition: PluginHookDefinition, handler: PluginHandler): void;
	registerCommand(definition: PluginCommandDefinition, handler: PluginHandler): void;
}
