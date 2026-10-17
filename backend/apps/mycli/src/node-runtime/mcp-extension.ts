import type { ExtensionDefinition } from "@mycli/extensions";
import {
	GetMcpPromptTool,
	ListMcpPromptsTool,
	ListMcpResourcesTool,
	ListMcpResourceTemplatesTool,
	ReadMcpResourceTool,
} from "@mycli/integrations";
import type { RuntimeIntegrationComposition } from "./integration-composition.ts";

export interface McpExtensionOptions {
	readonly composition: RuntimeIntegrationComposition;
}

/**
 * MCP as an extension. It owns both halves of what MCP puts in the session catalog: the builtin
 * adapters that read resources and prompts, and every tool the connected servers expose.
 *
 * The registrations are read on every call because servers connect, refresh, and disconnect while
 * the session runs. The feature knows it owns the `mcp` source; the app does not have to.
 */
export function createMcpExtension(options: McpExtensionOptions): ExtensionDefinition {
	const { composition } = options;
	return {
		id: "mcp",
		tools: {
			tools: () => [
				new ListMcpResourcesTool(composition.mcpResourceService),
				new ListMcpResourceTemplatesTool(composition.mcpResourceService),
				new ReadMcpResourceTool(composition.mcpResourceService),
				new ListMcpPromptsTool(composition.mcpPromptService),
				new GetMcpPromptTool(composition.mcpPromptService),
			],
			toolRegistrations: () => composition.registrations
				.filter((registration) => registration.source === "mcp"),
		},
	};
}
