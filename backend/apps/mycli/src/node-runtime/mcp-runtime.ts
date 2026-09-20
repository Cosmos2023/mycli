import type * as McpRuntime from "@mycli/integrations/mcp";

let mcpRuntime: Promise<typeof McpRuntime> | undefined;
let requiredServerErrorCheck: (error: unknown) => boolean = () => false;

/**
 * The MCP runtime entry loads the Model Context Protocol SDK with its schema
 * and transport dependencies. Backend startup only loads it when MCP servers
 * are configured or an MCP tool runs.
 */
export function loadMcpRuntime(): Promise<typeof McpRuntime> {
	return mcpRuntime ??= import("@mycli/integrations/mcp").then((runtime) => {
		requiredServerErrorCheck = (error) => error instanceof runtime.McpRequiredServerError;
		return runtime;
	});
}

export function isMcpRequiredServerError(error: unknown): boolean {
	return requiredServerErrorCheck(error);
}
