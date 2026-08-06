import type { PluginV2Manifest } from "@mycli/contracts";

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
