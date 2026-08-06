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
	classifyMcpFailure,
	isMcpAbort,
	mcpFailureErrorKind,
} from "./diagnostics.ts";
import type {
	McpClientContract,
	McpContentItem,
	McpToolCallResult,
	McpToolDescriptor,
} from "./types.ts";

const MODEL_OUTPUT_LIMIT = 4_000;
const RAW_TEXT_LIMIT = 12_000;
const METADATA_LIMIT = 12_000;

class McpTool implements ToolAdapter {
	readonly definition: ToolDefinition;
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
			const failureCategory = classifyMcpFailure(error);
			return Object.freeze({
				success: false,
				modelOutput: `MCP tool failed.\nError kind: ${failureCategory}`,
				summary: `MCP ${this.#descriptor.serverId}.${this.#descriptor.name} failed`,
				errorKind: mcpFailureErrorKind(failureCategory),
				metadata: Object.freeze({
					server: this.#descriptor.serverId,
					tool: this.#descriptor.name,
					failureCategory,
				}),
			});
		}
		const rendered = renderResult(result);
		const modelOutput = boundText(rendered.text || "MCP tool returned no content.", MODEL_OUTPUT_LIMIT);
		const metadata = boundMetadata(this.#descriptor, result, rendered.rawTruncated);
		const summary = result.isError
			? `MCP ${this.#descriptor.serverId}.${this.#descriptor.name} failed`
			: `MCP ${this.#descriptor.serverId}.${this.#descriptor.name} completed`;
		return Object.freeze({
			success: !result.isError,
			modelOutput,
			summary,
			...(result.isError ? { errorKind: "mcp_tool_error" } : {}),
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

function renderResult(result: McpToolCallResult): { readonly text: string; readonly rawTruncated: boolean } {
	const parts: string[] = [];
	let rawTruncated = false;
	for (const item of result.content) {
		const rendered = renderContentItem(item);
		if (rendered.text) parts.push(rendered.text);
		rawTruncated ||= rendered.rawTruncated;
	}
	if (result.structuredContent !== undefined) {
		const structured = jsonText(result.structuredContent);
		const bounded = boundText(structured, RAW_TEXT_LIMIT);
		parts.push(bounded);
		rawTruncated ||= bounded !== structured;
	}
	return { text: parts.join("\n"), rawTruncated };
}

function renderContentItem(item: McpContentItem): { readonly text: string; readonly rawTruncated: boolean } {
	if (item.type === "text" && typeof item.text === "string") {
		const text = boundText(item.text, RAW_TEXT_LIMIT);
		return { text, rawTruncated: text !== item.text };
	}
	if (item.type === "json") {
		const raw = jsonText(item.value ?? item.json ?? item.data);
		const text = boundText(raw, RAW_TEXT_LIMIT);
		return { text, rawTruncated: text !== raw };
	}
	if (item.type === "image") {
		const mediaType = typeof item.mediaType === "string" ? item.mediaType : "image";
		return { text: `[MCP image: ${mediaType}]`, rawTruncated: false };
	}
	const raw = jsonText(item);
	const text = boundText(raw, RAW_TEXT_LIMIT);
	return { text, rawTruncated: text !== raw };
}

function boundMetadata(
	descriptor: McpToolDescriptor,
	result: McpToolCallResult,
	rawTruncated: boolean,
): Readonly<Record<string, unknown>> {
	const content = result.content.map((item) => boundedContentItem(item));
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

function boundedContentItem(item: McpContentItem): Readonly<Record<string, unknown>> {
	return Object.freeze(Object.fromEntries(Object.entries(item).map(([key, value]) => [
		key,
		typeof value === "string" ? boundText(value, RAW_TEXT_LIMIT) : value,
	])));
}

function jsonText(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "null";
	} catch {
		return "[unserializable MCP content]";
	}
}

function boundText(value: string, limit: number): string {
	if (value.length <= limit) return value;
	const suffix = "... [truncated]";
	return `${value.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

function abortError(): Error {
	const error = new Error("interrupted");
	error.name = "AbortError";
	return error;
}
