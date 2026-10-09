import { TOOL_RESULT_OUTPUT_MAX_CHARS } from "@mycli/core";
import {
	GET_MCP_PROMPT_TOOL_DEFINITION,
	LIST_MCP_PROMPTS_TOOL_DEFINITION,
	type ToolAdapter,
	type ToolAdapterResult,
	type ToolExecutionOptions,
} from "@mycli/tools";
import { describeMcpFailure, isMcpAbort, mcpFailureContext, mcpFailureErrorKind, mcpFailureText, type McpOperation } from "./diagnostics.ts";
import { boundMcpText } from "./result-content.ts";
import type { McpPromptService, McpResourceFailure } from "./types.ts";

const MAX_PROMPT_ROWS = 50;
const MAX_PROMPT_ARGUMENTS = 64;
const MAX_ARGUMENT_CHARS = 4_096;
const MAX_MESSAGE_CHARS = 4_096;

export class ListMcpPromptsTool implements ToolAdapter {
	readonly definition = LIST_MCP_PROMPTS_TOOL_DEFINITION;
	readonly supportsParallelToolCalls = true;
	readonly #service: McpPromptService;

	constructor(service: McpPromptService) { this.#service = service; }

	async execute(args: Readonly<Record<string, unknown>>, options: ToolExecutionOptions): Promise<ToolAdapterResult> {
		options.signal.throwIfAborted();
		const server = identity(args.server);
		const cursor = args.cursor;
		if (args.server !== undefined && server === undefined) return invalidArguments();
		if (cursor !== undefined && (typeof cursor !== "string" || !cursor || cursor.length > 4_096 || server === undefined)) {
			return invalidArguments();
		}
		try {
			const listing = server !== undefined && this.#service.listPromptsPage
				? { ...await this.#service.listPromptsPage(server, options.signal, cursor as string | undefined), failures: [] }
				: await this.#service.listPrompts(options.signal, server);
			options.signal.throwIfAborted();
			return listResult(listing.prompts.map(({ serverId, ...prompt }) => ({ server: serverId, ...prompt })),
				server, "nextCursor" in listing ? listing.nextCursor as string | undefined : undefined, listing.failures);
		} catch (error) {
			return promptFailure(error, options, "prompts/list", server);
		}
	}
}

export class GetMcpPromptTool implements ToolAdapter {
	readonly definition = GET_MCP_PROMPT_TOOL_DEFINITION;
	readonly supportsParallelToolCalls = true;
	readonly #service: McpPromptService;

	constructor(service: McpPromptService) { this.#service = service; }

	async execute(args: Readonly<Record<string, unknown>>, options: ToolExecutionOptions): Promise<ToolAdapterResult> {
		options.signal.throwIfAborted();
		const server = identity(args.server);
		const name = identity(args.name);
		const argumentsValue = promptArguments(args.arguments);
		if (server === undefined || name === undefined || argumentsValue === undefined) return invalidArguments();
		try {
			const result = await this.#service.getPrompt(server, name, argumentsValue, options.signal);
			options.signal.throwIfAborted();
			return promptResult(server, name, result.description, result.messages);
		} catch (error) {
			return promptFailure(error, options, "prompts/get", server);
		}
	}
}

function promptResult(
	server: string,
	name: string,
	description: string | undefined,
	messages: readonly { readonly role: "user" | "assistant"; readonly text: string }[],
): ToolAdapterResult {
	const base = { server, name, ...(description === undefined ? {} : { description: boundMcpText(description, 512) }) };
	if (JSON.stringify(base).length + 128 > TOOL_RESULT_OUTPUT_MAX_CHARS) {
		return failure("prompt_too_large", "MCP prompt metadata exceeds the output limit.");
	}
	const rows: Readonly<Record<string, unknown>>[] = [];
	let truncated = false;
	for (const message of messages) {
		const row = { role: message.role, text: boundMcpText(message.text, MAX_MESSAGE_CHARS) };
		if (JSON.stringify({ ...base, messages: [...rows, row], truncated: true }).length > TOOL_RESULT_OUTPUT_MAX_CHARS) {
			truncated = true;
			break;
		}
		if (message.text.length > MAX_MESSAGE_CHARS) truncated = true;
		rows.push(row);
	}
	if (rows.length === 0 && messages.length > 0) return failure("prompt_too_large", "MCP prompt exceeds the output limit.");
	const payload = { ...base, messages: rows, ...(truncated || rows.length < messages.length ? { truncated: true } : {}) };
	return { success: true, modelOutput: JSON.stringify(payload), summary: `MCP prompt ${name}`,
		metadata: { prompt: { server, name, messages: rows.length, truncated: payload.truncated === true } } };
}

function listResult(
	entries: readonly Readonly<Record<string, unknown>>[],
	server: string | undefined,
	nextCursor: string | undefined,
	failures: readonly McpResourceFailure[],
): ToolAdapterResult {
	const base = { ...(server === undefined ? {} : { server }), ...(nextCursor === undefined ? {} : { nextCursor }),
		...(failures.length ? { failures: failures.map(({ server: failed, errorKind }) => ({ server: failed, errorKind })) } : {}) };
	if (JSON.stringify(base).length + 128 > TOOL_RESULT_OUTPUT_MAX_CHARS) {
		return failure("prompt_too_large", "MCP prompt cursor exceeds the output limit.");
	}
	const rows: Readonly<Record<string, unknown>>[] = [];
	for (const entry of entries) {
		const row = { ...entry, name: boundMcpText(entry.name as string, 128),
			description: boundMcpText(entry.description as string, 512) };
		if (JSON.stringify({ ...base, prompts: [...rows, row], truncated: true }).length > TOOL_RESULT_OUTPUT_MAX_CHARS) break;
		rows.push(row);
		if (rows.length >= MAX_PROMPT_ROWS) break;
	}
	const truncated = rows.length < entries.length;
	const payload = { ...base, prompts: rows, ...(truncated ? { truncated: true } : {}) };
	return { success: true, modelOutput: JSON.stringify(payload), summary: "MCP prompts",
		metadata: { prompts: { count: rows.length, truncated, ...(server === undefined ? {} : { server }) } } };
}

function promptFailure(error: unknown, options: ToolExecutionOptions, operation: McpOperation, server?: string): ToolAdapterResult {
	if (options.signal.aborted || isMcpAbort(error)) throw error;
	const diagnostic = describeMcpFailure(error, { operation });
	const kind = error instanceof Error && error.message === "unknown_mcp_server" ? "unknown_mcp_server"
		: error instanceof Error && error.message === "mcp_prompts_unsupported" ? "mcp_prompts_unsupported"
			: mcpFailureErrorKind(diagnostic.category);
	const errorContext = options.errorContextVersion === 1 ? mcpFailureContext(diagnostic, options.callId, server) : undefined;
	return { success: false, modelOutput: `The MCP prompt request failed.\n${mcpFailureText(diagnostic)}`,
		summary: "MCP prompt unavailable", errorKind: kind, ...(errorContext ? { errorContext } : {}),
		metadata: errorContext ? { error_context: errorContext } : {} };
}

function failure(errorKind: string, message: string): ToolAdapterResult {
	return { success: false, modelOutput: `${message}\nError kind: ${errorKind}`, summary: "MCP prompt unavailable", errorKind, metadata: {} };
}

function invalidArguments(): ToolAdapterResult {
	return failure("invalid_arguments", "Invalid MCP prompt arguments or continuation.");
}

function identity(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 128 ? value : undefined;
}

/** Prompt arguments are bounded string pairs; anything else is rejected before dispatch. */
function promptArguments(value: unknown): Readonly<Record<string, string>> | undefined {
	if (value === undefined) return Object.freeze({});
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const entries = Object.entries(value);
	if (entries.length > MAX_PROMPT_ARGUMENTS) return undefined;
	const result: Record<string, string> = {};
	for (const [key, item] of entries) {
		if (!key || key.length > 128 || typeof item !== "string" || item.length > MAX_ARGUMENT_CHARS) return undefined;
		result[key] = item;
	}
	return Object.freeze(result);
}
