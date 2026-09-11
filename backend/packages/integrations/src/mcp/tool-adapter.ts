import type { ToolDefinition } from "@mycli/core";
import type {
	ToolAdapter,
	ToolAdapterResult,
	ToolExecutionOptions,
} from "@mycli/tools";
import { createIntegrationId, providerSafeToolName } from "../foundation/ids.ts";
import { defineIntegrationRegistration } from "../foundation/registration.ts";
import type { IntegrationRegistration } from "../foundation/registration.ts";
import {
	describeMcpFailure,
	isMcpAbort,
	mcpFailureContext,
	mcpFailureErrorKind,
	mcpFailureText,
} from "./diagnostics.ts";
import type {
	McpClientContract,
	McpToolCallResult,
	McpToolDescriptor,
} from "./types.ts";
import { boundMcpText as boundText, contentMetadata, jsonText, renderMcpContent } from "./result-content.ts";

const MODEL_OUTPUT_LIMIT = 4_000;
const METADATA_LIMIT = 12_000;

class McpTool implements ToolAdapter {
	readonly definition: ToolDefinition;
	readonly supportsParallelToolCalls: boolean;
	readonly #client: McpClientContract;
	readonly #descriptor: McpToolDescriptor;

	constructor(
		client: McpClientContract,
		descriptor: McpToolDescriptor,
		definition: ToolDefinition,
	) {
		this.#client = client;
		this.#descriptor = descriptor;
		this.definition = definition;
		this.supportsParallelToolCalls = descriptor.supportsParallelToolCalls;
	}

	async execute(
		argumentsValue: Readonly<Record<string, unknown>>,
		options: ToolExecutionOptions,
	): Promise<ToolAdapterResult> {
		if (options.signal.aborted) throw abortError();
		let result: McpToolCallResult;
		try {
			result = await this.#client.callTool(
				this.#descriptor.name,
				argumentsValue,
				options.signal,
			);
		} catch (error) {
			if (options.signal.aborted || isMcpAbort(error)) throw error;
			const failure = describeMcpFailure(error, { operation: "tools/call" });
			const failureCategory = failure.category;
			const errorContext = options.errorContextVersion === 1
				? mcpFailureContext(failure, options.callId, this.#descriptor.serverId) : undefined;
			return Object.freeze({
				success: false,
				modelOutput: `MCP tool failed.\n${mcpFailureText(failure)}`,
				summary: `MCP ${this.#descriptor.serverId}.${this.#descriptor.name} failed`,
				errorKind: mcpFailureErrorKind(failureCategory),
				...(errorContext ? { errorContext } : {}),
				metadata: Object.freeze({
					server: this.#descriptor.serverId,
					tool: this.#descriptor.name,
					failureCategory,
					...(errorContext ? { error_context: errorContext } : {}),
				}),
			});
		}
		const rendered = renderMcpContent(result);
		const modelOutput = boundText(rendered.text || "MCP tool returned no content.", MODEL_OUTPUT_LIMIT);
		const metadata = boundMetadata(this.#descriptor, result, rendered.rawTruncated);
		const summary = result.isError || rendered.invalidImages
			? `MCP ${this.#descriptor.serverId}.${this.#descriptor.name} failed`
			: `MCP ${this.#descriptor.serverId}.${this.#descriptor.name} completed`;
		return Object.freeze({
			success: !result.isError && !rendered.invalidImages,
			modelOutput,
			...(rendered.images.length > 0 ? { images: rendered.images } : {}),
			summary,
			...(rendered.invalidImages ? { errorKind: "mcp_invalid_image" }
				: result.isError ? { errorKind: "mcp_tool_error" } : {}),
			metadata,
		});
	}
}

export function createMcpToolRegistration(
	client: McpClientContract,
	descriptor: McpToolDescriptor,
): IntegrationRegistration {
	validateInputSchema(descriptor.inputSchema);
	const inputSchema = hostInputSchema(descriptor.inputSchema);
	const id = createIntegrationId("mcp", descriptor.serverId, descriptor.name);
	const definition: ToolDefinition = Object.freeze({
		id,
		name: providerSafeToolName("mcp", descriptor.serverId, descriptor.name),
		description: descriptor.description || `MCP tool ${descriptor.name}`,
		inputSchema,
	});
	const adapter = new McpTool(client, descriptor, definition);
	return defineIntegrationRegistration({
		id,
		source: "mcp",
		definition,
		adapter,
		originMetadata: { server: descriptor.serverId, tool: descriptor.name },
		...(descriptor.serverInstructions ? { sourceDescription: descriptor.serverInstructions } : {}),
	});
}

function hostInputSchema(
	schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	return Object.freeze(Object.fromEntries(
		Object.entries(schema).filter(([key]) => key !== "$schema"),
	));
}

function validateInputSchema(schema: Readonly<Record<string, unknown>>): void {
	if (schema.type !== "object") throw new Error("invalid_mcp_tool_schema");
	const properties = schema.properties;
	if (properties !== undefined && !isRecord(properties)) {
		throw new Error("invalid_mcp_tool_schema");
	}
	if (isRecord(properties) && Object.values(properties).some((value) => !isRecord(value))) {
		throw new Error("invalid_mcp_tool_schema");
	}
	const required = schema.required;
	if (required !== undefined && (
		!Array.isArray(required)
		|| required.some((value) => typeof value !== "string" || !value)
		|| new Set(required).size !== required.length
	)) {
		throw new Error("invalid_mcp_tool_schema");
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundMetadata(
	descriptor: McpToolDescriptor,
	result: McpToolCallResult,
	rawTruncated: boolean,
): Readonly<Record<string, unknown>> {
	const content = result.content.map(contentMetadata);
	const base = {
		server: descriptor.serverId,
		tool: descriptor.name,
		isError: result.isError,
		rawTruncated,
		content,
		...(result.structuredContent === undefined
			? {}
			: { structuredContent: result.structuredContent }),
	};
	if (jsonText(base).length <= METADATA_LIMIT) return Object.freeze(base);
	return Object.freeze({
		server: descriptor.serverId,
		tool: descriptor.name,
		isError: result.isError,
		rawTruncated: true,
		contentCount: result.content.length,
	});
}

function abortError(): Error {
	const error = new Error("interrupted");
	error.name = "AbortError";
	return error;
}
