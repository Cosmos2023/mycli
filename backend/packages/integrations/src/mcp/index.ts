/**
 * MCP runtime entry. These modules load the Model Context Protocol SDK, so the
 * startup path imports this entry only when MCP servers are configured.
 */
export { McpClient } from "./client.ts";
export type { McpClientOptions } from "./client.ts";
export {
	classifyMcpFailure,
	isMcpAbort,
	mcpFailureErrorKind,
} from "./diagnostics.ts";
export type { McpFailureCategory } from "./diagnostics.ts";
export { LegacyHttpTransport } from "./legacy-http-transport.ts";
export type { LegacyHttpTransportOptions } from "./legacy-http-transport.ts";
export { McpManagementService } from "./management.ts";
export type {
	McpManagementResponse,
	McpManagementRow,
	McpManagementServiceOptions,
} from "./management.ts";
export { McpManager, McpRequiredServerError } from "./manager.ts";
export type { McpManagerDiscovery, McpManagerOptions } from "./manager.ts";
export { createMcpToolRegistration } from "./tool-adapter.ts";
export { ListMcpResourcesTool, ListMcpResourceTemplatesTool, ReadMcpResourceTool } from "./resource-tools.ts";
export { loginMcpOAuth } from "./oauth-login.ts";
export { McpOAuthStore, McpOAuthError } from "./oauth-store.ts";
export { policyMcpFetch } from "./http-fetch.ts";
export type { McpElicitationPrompt, McpElicitationHandler, McpInvocationContext } from "./elicitation.ts";
export type { McpResourceService } from "./types.ts";
