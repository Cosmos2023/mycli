export {
	classifyProviderError,
	ProviderFailure,
	providerFailurePublicMessage,
	providerFailureToRuntimeFailure,
	providerFailureReason,
} from "./errors.ts";
export type { ProviderFailureOptions, ProviderFailureProjection } from "./errors.ts";
export type {
	ModelProvider,
	ProviderCapabilities,
	ProviderStreamOptions,
	ProviderStreamPhase,
} from "./model-provider.ts";
export { ProviderRegistry } from "./registry/provider-registry.ts";
export { resolveProviderNativeTransport, captureProviderNativeEnvironment } from "./registry/provider-native-transport.ts";
export { loginNativeProvider, inspectNativeProviderAuth } from "./auth/native-auth-management.ts";
export type { NativeAuthTarget, NativeAuthStatus, NativeAuthPrompt, NativeAuthEvent, NativeAuthInteraction } from "./auth/native-auth-management.ts";
export type { ResolveProviderNativeTransportInput } from "./registry/provider-native-transport.ts";
export type {
	ProviderTransportConfig,
	ProviderRegistryOptions,
} from "./registry/provider-registry.ts";
export type {
	ProviderDirectoryDisabledReason,
	ProviderDirectoryEntry,
	ProviderDirectorySnapshot,
	ProviderDirectoryStatus,
	ProviderInputModality,
	PiAiCompatOverride,
	ProviderModelDirectoryEntry,
	ProviderRouteActivation,
	ProviderRouteDescriptor,
	ProviderRouteModelPolicy,
	ProviderRouteSource,
	ProviderRouteSupportTier,
} from "./registry/provider-directory-types.ts";
export { loadPiAiProviderDirectory, loadPiAiProviderEntry } from "./registry/provider-directory.ts";
export {
	mergePiAiCompatOverrides,
	validatePiAiCompatOverride,
} from "./pi-ai/pi-ai-compat.ts";
