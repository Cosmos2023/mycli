export { createSafeDiagnostic } from "./foundation/diagnostics.ts";
export type {
	IntegrationDiagnostic,
	SafeDiagnosticInput,
} from "./foundation/diagnostics.ts";
export {
	createIntegrationId,
	INTEGRATION_ID_MAX_LENGTH,
	providerSafeToolName,
	PROVIDER_SAFE_TOOL_NAME_MAX_LENGTH,
} from "./foundation/ids.ts";
export type { IntegrationSource } from "./foundation/ids.ts";
export { IntegrationLifecycleStack } from "./foundation/lifecycle.ts";
export type {
	IntegrationLifecycle,
	IntegrationLifecycleStackOptions,
} from "./foundation/lifecycle.ts";
export { defineIntegrationRegistration } from "./foundation/registration.ts";
export type { IntegrationRegistration } from "./foundation/registration.ts";
export { HookAllowlistStore, HookAllowlistStoreError } from "./hooks/allowlist.ts";
export {
	hookCommandDigest,
	hookConfigPathHash,
	hookIdentity,
} from "./hooks/allowlist.ts";
export {
	configuredHookMatches,
	discoverHookConfig,
} from "./hooks/config.ts";
export type { DiscoverHookConfigOptions } from "./hooks/config.ts";
export { HookManagementService } from "./hooks/management.ts";
export type {
	HookManagementResponse,
	HookManagementRow,
	HookManagementServiceOptions,
} from "./hooks/management.ts";
export { HookManager } from "./hooks/manager.ts";
export type {
	HookManagerOptions,
	HookRegistration,
} from "./hooks/manager.ts";
export { ConfiguredHookRunner } from "./hooks/runner.ts";
export type { ConfiguredHookRunnerOptions } from "./hooks/runner.ts";
export type {
	ConfiguredHookExecutorContract,
	ConfiguredHookMatcher,
	ConfiguredHookMatchInput,
	ConfiguredHookSpec,
	ConfiguredHookTraceSummary,
	HookAllowlistSnapshot,
	HookApprovalReason,
	HookApprovalRecord,
	HookApprovalStatus,
	HookConfigDiagnostic,
	HookConfigDiscovery,
	HookConfigScope,
	HookEnvironmentPolicy,
	HookShellKind,
	HookWorkingDirectory,
} from "./hooks/types.ts";
export { McpClient } from "./mcp/client.ts";
export type { McpClientOptions } from "./mcp/client.ts";
export { discoverMcpConfig } from "./mcp/config.ts";
export type { DiscoverMcpConfigOptions } from "./mcp/config.ts";
export {
	classifyMcpFailure,
	isMcpAbort,
	mcpFailureErrorKind,
} from "./mcp/diagnostics.ts";
export type { McpFailureCategory } from "./mcp/diagnostics.ts";
export { LegacyHttpTransport } from "./mcp/legacy-http-transport.ts";
export type { LegacyHttpTransportOptions } from "./mcp/legacy-http-transport.ts";
export { McpManagementService } from "./mcp/management.ts";
export type {
	McpManagementResponse,
	McpManagementRow,
	McpManagementServiceOptions,
} from "./mcp/management.ts";
export { McpManager } from "./mcp/manager.ts";
export type {
	McpManagerDiscovery,
	McpManagerOptions,
} from "./mcp/manager.ts";
export { McpResourceAdapter } from "./mcp/resource-adapter.ts";
export { createMcpToolRegistration } from "./mcp/tool-adapter.ts";
export type {
	McpClientContract,
	McpConfigDiagnostic,
	McpConfigDiscovery,
	McpConfigSource,
	McpContentItem,
	McpManagedClient,
	McpProtocolClient,
	McpResourceClientContract,
	McpResourceContent,
	McpResourceDescriptor,
	McpServerConfig,
	McpServerDiscovery,
	McpToolCallResult,
	McpToolDescriptor,
	McpTransportKind,
} from "./mcp/types.ts";
export { loadPluginManifest } from "./plugins/manifest.ts";
export type { LoadPluginManifestOptions } from "./plugins/manifest.ts";
export { discoverPlugins } from "./plugins/discovery.ts";
export type { DiscoverPluginsOptions } from "./plugins/discovery.ts";
export type {
	DiscoveredPlugin,
	InvalidPluginCandidate,
	LoadedPluginManifest,
	PluginCandidate,
	PluginDiagnostic,
	PluginDiagnosticSource,
	PluginDiscovery,
	PluginEnablement,
	PluginManifestLoadResult,
	PluginMigrationDiagnostic,
	PluginSource,
} from "./plugins/types.ts";
export { renderSkillCatalog } from "./skills/catalog.ts";
export type { RenderSkillCatalogOptions } from "./skills/catalog.ts";
export { SkillRegistry } from "./skills/registry.ts";
export type { SkillRegistryOptions } from "./skills/registry.ts";
export {
	createSkillToolRegistration,
	SKILL_TOOL_DEFINITION,
	skillInvocationArtifactFromMetadata,
	SkillTool,
} from "./skills/skill-tool.ts";
export type { SkillToolOptions } from "./skills/skill-tool.ts";
export type {
	SkillDefinition,
	SkillDiagnosticIssue,
	SkillInvocationArtifact,
	SkillRegistryDiagnostics,
	SkillSourceKind,
} from "./skills/types.ts";
