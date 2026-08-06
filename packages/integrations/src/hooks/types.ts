import type { HookInvocation, HookPoint, HookResult } from "@mycli/core";

export type HookConfigScope = "user" | "repo";
export type HookWorkingDirectory = "workspace" | "config";
export type HookEnvironmentPolicy = "minimal" | "inherit_safe";
export type HookShellKind = "posix" | "powershell" | "cmd";

export type ConfiguredHookMatcher =
	| { readonly kind: "any" }
	| { readonly kind: "tool_name"; readonly value: string }
	| { readonly kind: "pattern"; readonly value: string };

export interface ConfiguredHookSpec {
	readonly hookId: string;
	readonly name: string;
	readonly hookPoint: HookPoint;
	readonly command: readonly string[];
	readonly shellKind?: HookShellKind;
	readonly enabled: boolean;
	readonly timeoutMs: number;
	readonly workingDirectory: HookWorkingDirectory;
	readonly envPolicy: HookEnvironmentPolicy;
	readonly matcher: ConfiguredHookMatcher;
	readonly scope: HookConfigScope;
	readonly configPath: string;
}

export interface HookConfigDiagnostic {
	readonly scope: HookConfigScope;
	readonly fileLabel: string;
	readonly hookId: string;
	readonly errorClass: string;
}

export interface HookConfigDiscovery {
	readonly hooks: readonly ConfiguredHookSpec[];
	readonly diagnostics: readonly HookConfigDiagnostic[];
}

export interface ConfiguredHookMatchInput {
	readonly toolName?: string;
	readonly source?: string;
}

export interface HookApprovalRecord {
	readonly schemaVersion: 1;
	readonly identity: string;
	readonly scope: HookConfigScope;
	readonly configPathHash: string;
	readonly commandDigest: string;
	readonly approvedAt: string;
}

export type HookApprovalReason =
	| "matched"
	| "allowlist_missing"
	| "allowlist_invalid"
	| "entry_missing"
	| "config_path_changed"
	| "digest_changed";

export interface HookApprovalStatus {
	readonly allowed: boolean;
	readonly reason: HookApprovalReason;
	readonly commandDigest: string;
}

export interface HookAllowlistSnapshot {
	readonly records: readonly HookApprovalRecord[];
	readonly issues: readonly string[];
}

export interface ConfiguredHookTraceSummary {
	readonly executionId: string;
	readonly hookId: string;
	readonly hookName: string;
	readonly hookPoint: HookPoint;
	readonly status: "ok" | "error" | "interrupted";
	readonly action: HookResult["action"];
	readonly durationMs: number;
	readonly exitCode?: number;
	readonly stdoutChars: number;
	readonly stderrChars: number;
	readonly stdoutTruncated: boolean;
	readonly stderrTruncated: boolean;
	readonly message?: string;
}

export interface ConfiguredHookExecutorContract {
	run(
		spec: ConfiguredHookSpec,
		invocation: HookInvocation,
		signal: AbortSignal,
	): Promise<HookResult>;
}
