import {
	LIST_MCP_RESOURCES_TOOL_DEFINITION,
	LIST_MCP_RESOURCE_TEMPLATES_TOOL_DEFINITION,
	READ_MCP_RESOURCE_TOOL_DEFINITION,
	type ToolAdapter,
	type ToolAdapterResult,
	type ToolExecutionOptions,
} from "@mycli/tools";
import { legacyOffsetSchema } from "./legacy-offset-schema.ts";
import type { McpResourceService } from "./types.ts";

/**
 * Resource adapters keep their manifest metadata free of the MCP SDK and load
 * the real implementation on first use. Every session registers them, so the
 * eager import would otherwise pull the SDK into every backend start.
 */
export class ListMcpResourcesTool implements ToolAdapter {
	readonly definition = LIST_MCP_RESOURCES_TOOL_DEFINITION;
	readonly legacyInputSchemas = [legacyOffsetSchema(LIST_MCP_RESOURCES_TOOL_DEFINITION.inputSchema)];
	readonly supportsParallelToolCalls = true;
	readonly #service: McpResourceService;

	constructor(service: McpResourceService) { this.#service = service; }

	async execute(args: Readonly<Record<string, unknown>>, options: ToolExecutionOptions): Promise<ToolAdapterResult> {
		const { ListMcpResourcesTool: Tool } = await import("./resource-tools.ts");
		return new Tool(this.#service).execute(args, options);
	}
}

export class ListMcpResourceTemplatesTool implements ToolAdapter {
	readonly definition = LIST_MCP_RESOURCE_TEMPLATES_TOOL_DEFINITION;
	readonly supportsParallelToolCalls = true;
	readonly #service: McpResourceService;

	constructor(service: McpResourceService) { this.#service = service; }

	async execute(args: Readonly<Record<string, unknown>>, options: ToolExecutionOptions): Promise<ToolAdapterResult> {
		const { ListMcpResourceTemplatesTool: Tool } = await import("./resource-tools.ts");
		return new Tool(this.#service).execute(args, options);
	}
}

export class ReadMcpResourceTool implements ToolAdapter {
	readonly definition = READ_MCP_RESOURCE_TOOL_DEFINITION;
	readonly legacyInputSchemas = [legacyOffsetSchema(READ_MCP_RESOURCE_TOOL_DEFINITION.inputSchema)];
	readonly supportsParallelToolCalls = true;
	readonly #service: McpResourceService;

	constructor(service: McpResourceService) { this.#service = service; }

	async execute(args: Readonly<Record<string, unknown>>, options: ToolExecutionOptions): Promise<ToolAdapterResult> {
		const { ReadMcpResourceTool: Tool } = await import("./resource-tools.ts");
		return new Tool(this.#service).execute(args, options);
	}
}
