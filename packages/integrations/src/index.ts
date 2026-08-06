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
