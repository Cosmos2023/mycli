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
export {
	PluginHostError,
	PluginProcessHost,
} from "./plugins/process-host.ts";
export type {
	PluginProcessHostOptions,
} from "./plugins/process-host.ts";
export { createPluginToolRegistration } from "./plugins/tool-adapter.ts";
export { createPluginHookRegistration } from "./plugins/hook-adapter.ts";
export { PluginCommandRegistry } from "./plugins/command-registry.ts";
export type {
	PluginCommandDescriptor,
	PluginCommandResult,
} from "./plugins/command-registry.ts";
export { PluginRuntime } from "./plugins/runtime.ts";
export type {
	PluginRuntimeOptions,
	PluginRuntimeRecord,
	PluginRuntimeRecordStatus,
} from "./plugins/runtime.ts";
export { PluginManagementService } from "./plugins/management.ts";
export type {
	PluginManagementResponse,
	PluginManagementRow,
	PluginManagementServiceOptions,
} from "./plugins/management.ts";
export type {
	DiscoveredPlugin,
	InvalidPluginCandidate,
	LoadedPluginManifest,
	PluginCandidate,
	PluginCommandDefinition,
	PluginContextV2,
	PluginDiagnostic,
	PluginDiagnosticSource,
	PluginDiscovery,
	PluginEnablement,
	PluginHandler,
	PluginHookDefinition,
	PluginHostContract,
	PluginHostErrorKind,
	PluginHostStatus,
	PluginInvocationResult,
	PluginManifestLoadResult,
	PluginMigrationDiagnostic,
	PluginProtocolRegistration,
	PluginResultType,
	PluginSource,
	PluginToolDefinition,
} from "./plugins/types.ts";
export { renderSkillCatalog } from "./skills/catalog.ts";
export { builtinSkillRoot } from "./skills/builtin-root.ts";
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
export {
	BUILTIN_SUBAGENT_PROFILES,
	GLOBAL_CHILD_TOOL_DENYLIST,
} from "./subagents/builtin-profiles.ts";
export { SubagentProfileRegistry } from "./subagents/profile-registry.ts";
export type { SubagentProfileRegistryOptions } from "./subagents/profile-registry.ts";
export { resolveChildTools } from "./subagents/tool-scope.ts";
export type {
	ResolvedChildTools,
	ResolveChildToolsInput,
} from "./subagents/tool-scope.ts";
export { SubagentController } from "./subagents/controller.ts";
export type {
	ChildRuntimeCreateInput,
	ChildRuntimeEvent,
	ChildRuntimeFactory,
	ChildRuntimeHandle,
	ChildRuntimeResult,
	StartSubagentInput,
	SubagentControlContract,
	SubagentControllerOptions,
	SubagentControllerUpdate,
	SubagentMessageResult,
	SubagentOutputResult,
	SubagentStartResult,
} from "./subagents/controller.ts";
export {
	SUBAGENT_TOOL_MODEL_OUTPUT_MAX_CHARS,
	TASK_TOOL_DEFINITION,
	TaskTool,
} from "./subagents/task-tool.ts";
export type { TaskToolOptions } from "./subagents/task-tool.ts";
export {
	SUBAGENT_OUTPUT_TOOL_DEFINITION,
	SubagentOutputTool,
} from "./subagents/output-tool.ts";
export type { SubagentOutputToolOptions } from "./subagents/output-tool.ts";
export {
	SEND_MESSAGE_TOOL_DEFINITION,
	SendMessageTool,
} from "./subagents/send-message-tool.ts";
export type { SendMessageToolOptions } from "./subagents/send-message-tool.ts";
export { SubagentManagementService } from "./subagents/management.ts";
export type {
	SubagentManagementInspectResponse,
	SubagentManagementListResponse,
	SubagentManagementResponse,
	SubagentManagementServiceOptions,
} from "./subagents/management.ts";
export type {
	SubagentBudget,
	SubagentProfile,
	SubagentProfileIssue,
	SubagentProfileRecord,
	SubagentProfileRegistryDiagnostics,
	SubagentProfileSourceDirectory,
	SubagentProfileSourceKind,
} from "./subagents/types.ts";
