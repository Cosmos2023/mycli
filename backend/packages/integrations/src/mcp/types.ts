import type { McpFailure } from "./diagnostics.ts";

export type McpTransportKind = "stdio" | "http" | "streamable_http";
export type McpToolApprovalMode = "auto" | "prompt" | "approve";

export interface McpProcessPermissions {
	readonly mode?: "read-only" | "workspace-write";
	readonly network?: "enabled" | "disabled";
}

export interface McpToolAnnotations {
	readonly title?: string;
	readonly readOnlyHint?: boolean;
	readonly destructiveHint?: boolean;
	readonly idempotentHint?: boolean;
	readonly openWorldHint?: boolean;
}

export interface McpServerConfig {
	readonly id: string;
	readonly transport: McpTransportKind;
	readonly command?: string;
	readonly url?: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly headers: Readonly<Record<string, string>>;
	readonly enabled: boolean;
	readonly supportsParallelToolCalls: boolean;
	readonly timeoutMs: number;
	readonly startupTimeoutMs?: number;
	readonly toolTimeoutMs?: number;
	readonly required?: boolean;
	readonly enabledTools?: readonly string[];
	readonly disabledTools?: readonly string[];
	readonly defaultToolsApprovalMode?: McpToolApprovalMode;
	readonly tools?: Readonly<Record<string, { readonly approvalMode?: McpToolApprovalMode }>>;
	readonly sandbox?: McpProcessPermissions;
	readonly cwd?: string;
	readonly oauth?: {
		readonly clientId?: string;
		readonly scopes?: readonly string[];
		readonly callbackPort?: number;
	};
	readonly pluginDescription?: string;
	readonly plugin?: {
		readonly id: string;
		readonly source: "user" | "repo";
		readonly serverName: string;
	};
	readonly source?: "user" | "repository" | "plugin";
}

export type McpConfigSource = "user" | "repository";

export interface McpConfigDiagnostic {
	readonly source: McpConfigSource;
	readonly fileLabel: string;
	readonly serverId: string;
	readonly errorClass: string;
	readonly required?: boolean;
}

export interface McpConfigDiscovery {
	readonly servers: readonly McpServerConfig[];
	readonly diagnostics: readonly McpConfigDiagnostic[];
	get(id: string): McpServerConfig | undefined;
}

export interface McpToolDescriptor {
	readonly serverId: string;
	readonly name: string;
	readonly description: string;
	readonly serverInstructions?: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
	readonly supportsParallelToolCalls: boolean;
	readonly annotations?: McpToolAnnotations;
}

export interface McpContentItem {
	readonly type: string;
	readonly [key: string]: unknown;
}

export interface McpToolCallResult {
	readonly content: readonly McpContentItem[];
	readonly structuredContent?: unknown;
	readonly isError: boolean;
}

export interface McpResourceDescriptor {
	readonly serverId: string;
	readonly uri: string;
	readonly name: string;
	readonly description: string;
	readonly mimeType?: string;
}

export interface McpResourceTemplateDescriptor {
	readonly serverId: string;
	readonly uriTemplate: string;
	readonly name: string;
	readonly description: string;
	readonly mimeType?: string;
}

export interface McpResourcePage {
	readonly resources: readonly McpResourceDescriptor[];
	readonly nextCursor?: string;
}

export interface McpResourceTemplatePage {
	readonly resourceTemplates: readonly McpResourceTemplateDescriptor[];
	readonly nextCursor?: string;
}

export interface McpResourceTemplateListing extends McpResourceTemplatePage {
	readonly failures: readonly McpResourceFailure[];
}

export interface McpResourceFailure {
	readonly server: string;
	readonly errorKind: string;
	readonly diagnostic?: McpFailure;
}

export interface McpResourceContent {
	readonly serverId: string;
	readonly uri: string;
	readonly mimeType?: string;
	readonly text?: string;
	readonly blob?: string;
}

export interface McpResourceListing {
	readonly resources: readonly McpResourceDescriptor[];
	readonly failures: readonly McpResourceFailure[];
}

export interface McpResourceService {
	listResources(signal: AbortSignal, serverId?: string): Promise<McpResourceListing>;
	listResourcesPage?(serverId: string, signal: AbortSignal, cursor?: string): Promise<McpResourcePage>;
	listResourceTemplates?(signal: AbortSignal, serverId?: string, cursor?: string): Promise<McpResourceTemplateListing>;
	readResource(serverId: string, uri: string, signal: AbortSignal): Promise<readonly McpResourceContent[]>;
}

export interface McpProtocolClient {
	connect(signal: AbortSignal): Promise<void>;
	isConnected?(): boolean;
	getInstructions?(): string | undefined;
	listTools(signal: AbortSignal, cursor?: string): Promise<{
		readonly tools: readonly Readonly<Record<string, unknown>>[];
		readonly nextCursor?: string;
	}>;
	callTool(
		name: string,
		argumentsValue: Readonly<Record<string, unknown>>,
		signal: AbortSignal,
		context?: McpInvocationContext,
	): Promise<Readonly<Record<string, unknown>>>;
	listResources(signal: AbortSignal, cursor?: string): Promise<{
		readonly resources: readonly Readonly<Record<string, unknown>>[];
		readonly nextCursor?: string;
	}>;
	readResource(uri: string, signal: AbortSignal): Promise<{
		readonly contents: readonly Readonly<Record<string, unknown>>[];
	}>;
	listResourceTemplates?(signal: AbortSignal, cursor?: string): Promise<{
		readonly resourceTemplates: readonly Readonly<Record<string, unknown>>[];
		readonly nextCursor?: string;
	}>;
	close(): Promise<void>;
}

export interface McpClientContract {
	callTool(
		name: string,
		argumentsValue: Readonly<Record<string, unknown>>,
		signal: AbortSignal,
		context?: McpInvocationContext,
	): Promise<McpToolCallResult>;
}

export interface McpResourceClientContract {
	listResources(signal: AbortSignal): Promise<readonly McpResourceDescriptor[]>;
	listResourcesPage?(signal: AbortSignal, cursor?: string): Promise<McpResourcePage>;
	listResourceTemplates?(signal: AbortSignal, cursor?: string): Promise<McpResourceTemplatePage>;
	readResource(uri: string, signal: AbortSignal): Promise<readonly McpResourceContent[]>;
}

export interface McpManagedClient extends McpClientContract, McpResourceClientContract {
	listTools(signal: AbortSignal): Promise<readonly McpToolDescriptor[]>;
	close(): Promise<void>;
}

export interface McpServerDiscovery {
	readonly serverId: string;
	readonly transport: McpTransportKind;
	readonly enabled: boolean;
	readonly status: "ok" | "partial" | "disabled" | "failed";
	readonly toolCount: number;
	readonly resourceCount: number;
	readonly timeoutMs: number;
	readonly failureCategory?: string;
	readonly failures?: readonly McpDiscoveryFailure[];
	readonly failureCount?: number;
}

export interface McpDiscoveryFailure {
	readonly capability: "tools" | "resources";
	readonly tool?: string;
	readonly category: string;
}
import type { McpInvocationContext } from "./elicitation.ts";
