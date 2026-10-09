import {
	GET_MCP_PROMPT_TOOL_DEFINITION,
	LIST_MCP_PROMPTS_TOOL_DEFINITION,
	type ToolAdapter,
	type ToolAdapterResult,
	type ToolExecutionOptions,
} from "@mycli/tools";
import type { McpPromptService } from "./types.ts";

/**
 * Prompt adapters keep their manifest metadata free of the MCP SDK and load the
 * real implementation on first use, matching the resource adapters.
 */
export class ListMcpPromptsTool implements ToolAdapter {
	readonly definition = LIST_MCP_PROMPTS_TOOL_DEFINITION;
	readonly supportsParallelToolCalls = true;
	readonly #service: McpPromptService;

	constructor(service: McpPromptService) { this.#service = service; }

	async execute(args: Readonly<Record<string, unknown>>, options: ToolExecutionOptions): Promise<ToolAdapterResult> {
		const { ListMcpPromptsTool: Tool } = await import("./prompt-tools.ts");
		return new Tool(this.#service).execute(args, options);
	}
}

export class GetMcpPromptTool implements ToolAdapter {
	readonly definition = GET_MCP_PROMPT_TOOL_DEFINITION;
	readonly supportsParallelToolCalls = true;
	readonly #service: McpPromptService;

	constructor(service: McpPromptService) { this.#service = service; }

	async execute(args: Readonly<Record<string, unknown>>, options: ToolExecutionOptions): Promise<ToolAdapterResult> {
		const { GetMcpPromptTool: Tool } = await import("./prompt-tools.ts");
		return new Tool(this.#service).execute(args, options);
	}
}
