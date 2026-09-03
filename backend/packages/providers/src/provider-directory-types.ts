import type {
	ProtocolId,
	ProviderRouteId,
	ReasoningEffort,
} from "@mycli/core";

export type ProviderRouteSupportTier = "stable" | "experimental" | "compatible";
export type ProviderRouteSource = "pi_ai_builtin" | "pi_ai_declared";
export type ProviderRouteActivation = "active" | "inactive" | "unserviceable";
export type PiAiCompatOverride = Readonly<Record<string, unknown>>;

export type ProviderRouteModelPolicy =
	| Readonly<{ readonly kind: "catalog" }>
	| Readonly<{
		readonly kind: "subset" | "declared";
		readonly modelIds: readonly string[];
	}>;

export interface ProviderRouteDescriptor {
	readonly routeId: ProviderRouteId;
	readonly displayName: string;
	readonly supportTier: ProviderRouteSupportTier;
	readonly source: ProviderRouteSource;
	readonly catalogProviderId?: ProviderRouteId;
	readonly protocol: ProtocolId;
	readonly apiBaseUrl: string;
	readonly authRef: string;
	readonly activation: ProviderRouteActivation;
	readonly modelPolicy: ProviderRouteModelPolicy;
	readonly compat?: PiAiCompatOverride;
	readonly modelCompat?: Readonly<Record<string, PiAiCompatOverride>>;
	readonly snapshotVersion: number;
}

export type ProviderDirectoryStatus =
	| "serviceable"
	| "configuration_required"
	| "unsupported";

export type ProviderDirectoryDisabledReason =
	| "no_supported_models"
	| "unsupported_protocol"
	| "unsupported_auth";

export type ProviderInputModality = "text" | "image";

export interface ProviderModelDirectoryEntry {
	readonly catalogProviderId: ProviderRouteId;
	readonly id: string;
	readonly name: string;
	readonly protocol: ProtocolId;
	readonly baseUrl?: string;
	readonly input: readonly ProviderInputModality[];
	readonly reasoningEfforts: readonly ReasoningEffort[];
	readonly contextWindowTokens: number;
	readonly maxOutputTokens: number;
}

export interface ProviderDirectoryEntry {
	readonly catalogProviderId: ProviderRouteId;
	readonly name: string;
	readonly baseUrl?: string;
	readonly protocols: readonly ProtocolId[];
	readonly apiKeyServiceable: boolean;
	readonly endpointRequired: boolean;
	readonly status: ProviderDirectoryStatus;
	readonly models: readonly ProviderModelDirectoryEntry[];
	readonly disabledReason?: ProviderDirectoryDisabledReason;
}

export interface ProviderDirectorySnapshot {
	readonly generatedAt?: number;
	readonly providers: readonly ProviderDirectoryEntry[];
}
