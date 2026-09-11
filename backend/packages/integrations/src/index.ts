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
export { McpCatalogCache } from "./mcp/catalog-cache.ts";
export type {
	McpCachedServerCatalog,
	McpCatalogCacheContract,
	McpCatalogCacheOptions,
} from "./mcp/catalog-cache.ts";
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
export { pluginBundleContributions } from "./plugins/bundle-contributions.ts";
export type { PluginBundleContributions } from "./plugins/bundle-contributions.ts";
export { PluginPackageManager } from "./plugins/package-management.ts";
export type { PluginPackageRequest, PluginPackageResponse } from "./plugins/package-management.ts";
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
	type SkillLookup,
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
export { GLOBAL_CHILD_TOOL_DENYLIST, resolveChildTools } from "./subagents/tool-scope.ts";
export type {
	ResolvedChildTools,
	ResolveChildToolsInput,
} from "./subagents/tool-scope.ts";
export { SubagentController } from "./subagents/controller.ts";
export type {
	AgentCoordinationControlContract,
	AgentCoordinationEndpoint,
	AgentCoordinationInterruptResult,
	AgentCoordinationListRow,
	AgentCoordinationMailboxContract,
	AgentCoordinationMessageResult,
	AgentCoordinationRouteContext,
	ChildRuntimeCreateInput,
	ChildRuntimeEvent,
	ChildRuntimeFactory,
	ChildRuntimeHandle,
	ChildRuntimeResult,
	CreateSubagentSupervisorOptions,
	ResolvedSubagentSpawnContext,
	ResolveSubagentSpawnContextInput,
	StartSubagentInput,
	InterruptAgentCoordinationInput,
	ListAgentCoordinationInput,
	SendAgentCoordinationInput,
	SpawnAgentInput,
	SubagentControlContract,
	SubagentControllerOptions,
	SubagentMessageResult,
	SubagentOutputResult,
	SubagentStartResult,
	SubagentSupervisorContract,
	SubagentSupervisorSpawnInput,
	SubagentSupervisorStartResult,
} from "./subagents/controller.ts";
export {
	FOLLOWUP_TASK_TOOL_DEFINITION,
	INTERRUPT_AGENT_TOOL_DEFINITION,
	InterruptAgentTool,
	LIST_AGENTS_TOOL_DEFINITION,
	ListAgentsTool,
	SEND_AGENT_MESSAGE_TOOL_DEFINITION,
	SendAgentMessageTool,
	SPAWN_AGENT_TOOL_DEFINITION,
	SpawnAgentTool,
} from "./subagents/coordination-tools.ts";
export type { AgentCoordinationToolOptions } from "./subagents/coordination-tools.ts";
export {
	SUBAGENT_TOOL_MODEL_OUTPUT_MAX_CHARS,
} from "./subagents/tool-result.ts";
export {
	WAIT_AGENT_DEFAULT_TIMEOUT_MS,
	WAIT_AGENT_MAX_TIMEOUT_MS,
	WAIT_AGENT_MIN_TIMEOUT_MS,
	WAIT_AGENT_TOOL_DEFINITION,
	WaitAgentTool,
} from "./subagents/wait-agent-tool.ts";
export type {
	WaitAgentActivity,
	WaitAgentActivityContract,
	WaitAgentActivityInput,
	WaitAgentActivityResult,
	WaitAgentToolOptions,
} from "./subagents/wait-agent-tool.ts";
export {
	serializeSubagentTaskNotification,
	SUBAGENT_NOTIFICATION_MAX_BYTES,
	SUBAGENT_NOTIFICATION_RESULT_MAX_CHARS,
} from "./subagents/task-notification.ts";
export { ListMcpResourcesTool, ListMcpResourceTemplatesTool, ReadMcpResourceTool } from "./mcp/resource-tools.ts";
export type { McpResourceService, McpResourceListing, McpResourcePage, McpResourceTemplateDescriptor,
	McpResourceTemplatePage, McpResourceTemplateListing } from "./mcp/types.ts";
