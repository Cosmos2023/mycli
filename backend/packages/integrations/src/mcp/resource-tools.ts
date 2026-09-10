import { TOOL_RESULT_OUTPUT_MAX_CHARS } from "@mycli/core";
import {
	LIST_MCP_RESOURCES_TOOL_DEFINITION,
	LIST_MCP_RESOURCE_TEMPLATES_TOOL_DEFINITION,
	READ_MCP_RESOURCE_TOOL_DEFINITION,
	type ToolAdapter,
	type ToolAdapterResult,
	type ToolExecutionOptions,
} from "@mycli/tools";
import { classifyMcpFailure, isMcpAbort } from "./diagnostics.ts";
import { boundMcpText, renderMcpContent } from "./result-content.ts";
import type { McpResourceContent, McpResourceService } from "./types.ts";

export class ListMcpResourcesTool implements ToolAdapter {
	readonly definition = LIST_MCP_RESOURCES_TOOL_DEFINITION;
	readonly legacyInputSchemas = [legacyOffsetSchema(LIST_MCP_RESOURCES_TOOL_DEFINITION.inputSchema)];
	readonly supportsParallelToolCalls = true;
	readonly #service: McpResourceService;

	constructor(service: McpResourceService) { this.#service = service; }

	async execute(args: Readonly<Record<string, unknown>>, options: ToolExecutionOptions): Promise<ToolAdapterResult> {
		options.signal.throwIfAborted();
		if (args.offset === undefined && this.#service.listResourcesPage) {
			const parsed = listArguments(args);
			if (!parsed) return invalidArguments();
			try {
				const listing = parsed.server === undefined
					? await this.#service.listResources(options.signal)
					: { ...await this.#service.listResourcesPage(parsed.server, options.signal, parsed.cursor), failures: [] };
				options.signal.throwIfAborted();
				return listResult("resources", listing.resources.map(({ serverId, ...resource }) => ({ server: serverId, ...resource })),
					parsed.server, "nextCursor" in listing ? listing.nextCursor as string | undefined : undefined, listing.failures);
			} catch (error) { return resourceFailure(error, options.signal); }
		}
		if (args.cursor !== undefined) return invalidArguments();
		const offset = resourceOffset(args.offset);
		if (offset === undefined || (args.server !== undefined && !validIdentity(args.server, 128))) return invalidArguments();
		try {
			const listing = await this.#service.listResources(options.signal, args.server as string | undefined);
			options.signal.throwIfAborted();
			if (offset > listing.resources.length) return invalidArguments();
			const resources: Readonly<Record<string, unknown>>[] = [];
			const failures = listing.failures.slice(0, 16);
			const base = { failures, ...(listing.failures.length > failures.length ? { omitted_failures: listing.failures.length - failures.length } : {}) };
			let next = offset;
			for (const resource of listing.resources.slice(offset)) {
				const row = {
					server: resource.serverId, uri: resource.uri,
					name: boundMcpText(resource.name, 256), description: boundMcpText(resource.description, 512),
					...(resource.mimeType ? { mimeType: boundMcpText(resource.mimeType, 128) } : {}),
				};
				if (JSON.stringify({ ...base, resources: [...resources, row], next_offset: next + 1 }).length > TOOL_RESULT_OUTPUT_MAX_CHARS) {
					if (resources.length === 0) return failure("resource_too_large", "MCP resource identifier exceeds the output limit.");
					break;
				}
				resources.push(row);
				next += 1;
				if (resources.length >= 50) break;
			}
			return {
				success: listing.failures.length === 0 || listing.resources.length > 0,
				modelOutput: JSON.stringify({ ...base, resources, ...(next < listing.resources.length ? { next_offset: next } : {}) }),
				summary: `Listed ${resources.length} MCP resources`,
				...(listing.failures.length > 0 && listing.resources.length === 0 ? { errorKind: "mcp_resource_error" } : {}),
				metadata: { resourceCount: resources.length, failureCount: listing.failures.length },
			};
		} catch (error) { return resourceFailure(error, options.signal); }
	}
}

export class ListMcpResourceTemplatesTool implements ToolAdapter {
	readonly definition = LIST_MCP_RESOURCE_TEMPLATES_TOOL_DEFINITION;
	readonly supportsParallelToolCalls = true;
	readonly #service: McpResourceService;

	constructor(service: McpResourceService) { this.#service = service; }

	async execute(args: Readonly<Record<string, unknown>>, options: ToolExecutionOptions): Promise<ToolAdapterResult> {
		options.signal.throwIfAborted();
		const parsed = listArguments(args);
		if (!parsed || args.offset !== undefined) return invalidArguments();
		try {
			const listing = await this.#service.listResourceTemplates?.(options.signal, parsed.server, parsed.cursor)
				?? { resourceTemplates: [], failures: [] };
			options.signal.throwIfAborted();
			return listResult("resourceTemplates", listing.resourceTemplates.map(({ serverId, ...template }) => ({ server: serverId, ...template })),
				parsed.server, listing.nextCursor, listing.failures);
		} catch (error) { return resourceFailure(error, options.signal); }
	}
}

export class ReadMcpResourceTool implements ToolAdapter {
	readonly definition = READ_MCP_RESOURCE_TOOL_DEFINITION;
	readonly legacyInputSchemas = [legacyOffsetSchema(READ_MCP_RESOURCE_TOOL_DEFINITION.inputSchema)];
	readonly supportsParallelToolCalls = true;
	readonly #service: McpResourceService;

	constructor(service: McpResourceService) { this.#service = service; }

	async execute(args: Readonly<Record<string, unknown>>, options: ToolExecutionOptions): Promise<ToolAdapterResult> {
		options.signal.throwIfAborted();
		const offset = resourceOffset(args.offset);
		if (!validIdentity(args.server, 128) || !validIdentity(args.uri, 4_096) || offset === undefined) return invalidArguments();
		if (JSON.stringify({ server: args.server, uri: args.uri }).length + 128 > TOOL_RESULT_OUTPUT_MAX_CHARS) {
			return failure("resource_too_large", "MCP resource identifier exceeds the output limit.");
		}
		try {
			const contents = await this.#service.readResource(args.server, args.uri, options.signal);
			options.signal.throwIfAborted();
			const text = contents.map((content) => `${content.uri}\n${content.text ?? (content.blob === undefined
				? "[Empty resource]" : `[Binary resource: ${content.mimeType ?? "unknown"}]`)}`).join("\n\n");
			if (offset > text.length) return invalidArguments();
			const rendered = renderMcpContent({ isError: false, content: offset === 0 ? contents.flatMap((content) =>
				content.blob !== undefined && content.mimeType?.startsWith("image/")
					? [{ type: "image", mimeType: content.mimeType, data: content.blob }] : []) : [] });
			if (!Object.hasOwn(args, "offset")) {
				return { success: !rendered.invalidImages,
					modelOutput: nativeResourceOutput(args.server, args.uri, contents, rendered.invalidImages),
					summary: "Read MCP resource", ...(rendered.images.length ? { images: rendered.images } : {}),
					...(rendered.invalidImages ? { errorKind: "mcp_invalid_image" } : {}),
					metadata: { imageCount: rendered.images.length, contentCount: contents.length } };
			}
			let end = Math.min(text.length, offset + 6_000);
			const output = (): string => JSON.stringify({
				text: text.slice(offset, end), ...(end < text.length ? { next_offset: end } : {}),
				...(rendered.invalidImages ? { image_error: "Invalid or oversized MCP image data." } : {}),
			});
			while (output().length > TOOL_RESULT_OUTPUT_MAX_CHARS) end = offset + Math.floor((end - offset) / 2);
			return {
				success: !rendered.invalidImages, modelOutput: output(), summary: "Read MCP resource",
				...(rendered.images.length ? { images: rendered.images } : {}),
				...(rendered.invalidImages ? { errorKind: "mcp_invalid_image" } : {}),
				metadata: { imageCount: rendered.images.length, contentCount: contents.length },
			};
		} catch (error) { return resourceFailure(error, options.signal); }
	}
}

function resourceOffset(value: unknown): number | undefined {
	return value === undefined ? 0 : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nativeResourceOutput(server: string, uri: string, contents: readonly McpResourceContent[], invalidImages: boolean): string {
	const projected: Array<{ uri: string; mimeType?: string; text: string }> = [];
	const base = { server, uri, ...(invalidImages ? { image_error: "Invalid or oversized MCP image data." } : {}) };
	let remaining = TOOL_RESULT_OUTPUT_MAX_CHARS - JSON.stringify({ ...base, contents: [], truncated: true }).length;
	let truncated = false;
	for (const item of contents) {
		const row = { uri: item.uri, ...(item.mimeType ? { mimeType: item.mimeType } : {}), text: "" };
		const comma = projected.length > 0 ? 1 : 0;
		const overhead = JSON.stringify(row).length + comma;
		if (overhead > remaining) { truncated = true; break; }
		const source = item.text ?? (item.blob === undefined ? "[Empty resource]" : item.mimeType?.startsWith("image/")
			? invalidImages ? "[Image unavailable]" : "[Image attached]" : `[Binary resource: ${item.mimeType ?? "unknown"}]`);
		row.text = source.slice(0, remaining - overhead);
		while (JSON.stringify(row).length + comma > remaining) row.text = row.text.slice(0, Math.floor(row.text.length / 2));
		truncated ||= row.text.length < source.length;
		remaining -= JSON.stringify(row).length + comma;
		projected.push(row);
	}
	return JSON.stringify({ ...base, contents: projected, ...(truncated ? { truncated: true } : {}) });
}

function legacyOffsetSchema(schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	const properties = schema.properties as Readonly<Record<string, unknown>>;
	return { ...schema, properties: { ...Object.fromEntries(Object.entries(properties).filter(([key]) => key !== "cursor")),
		offset: { type: "integer", minimum: 0 } }, required: [...(schema.required as readonly string[] ?? []), "offset"] };
}

function listArguments(args: Readonly<Record<string, unknown>>): { server?: string; cursor?: string } | undefined {
	const server = typeof args.server === "string" ? args.server.trim() || undefined : args.server;
	const cursor = typeof args.cursor === "string" ? args.cursor.trim() || undefined : args.cursor;
	if ((server !== undefined && !validIdentity(server, 128)) || (cursor !== undefined
		&& (!validIdentity(cursor, 4_096) || server === undefined))) return undefined;
	return { ...(server === undefined ? {} : { server: server as string }), ...(cursor === undefined ? {} : { cursor: cursor as string }) };
}

function listResult(
	key: "resources" | "resourceTemplates",
	entries: readonly Readonly<Record<string, unknown>>[],
	server: string | undefined,
	nextCursor: string | undefined,
	failures: readonly { readonly server: string; readonly errorKind: string }[],
): ToolAdapterResult {
	const base = { ...(server === undefined ? {} : { server }), ...(nextCursor === undefined ? {} : { nextCursor }),
		...(failures.length ? { failures: failures.slice(0, 16) } : {}) };
	if (JSON.stringify(base).length + 128 > TOOL_RESULT_OUTPUT_MAX_CHARS) {
		return failure("resource_too_large", "MCP resource cursor exceeds the output limit.");
	}
	const rows: Readonly<Record<string, unknown>>[] = [];
	for (const entry of entries) {
		const row = { ...entry, name: boundMcpText(entry.name as string, 256), description: boundMcpText(entry.description as string, 512) };
		if (JSON.stringify({ ...base, [key]: [...rows, row], truncated: true }).length > TOOL_RESULT_OUTPUT_MAX_CHARS) break;
		rows.push(row);
	}
	if (entries.length > 0 && rows.length === 0) return failure("resource_too_large", "MCP resource identifier exceeds the output limit.");
	return { success: failures.length === 0 || rows.length > 0,
		modelOutput: JSON.stringify({ ...base, [key]: rows, ...(rows.length < entries.length ? { truncated: true } : {}) }),
		summary: `Listed ${rows.length} MCP ${key === "resources" ? "resources" : "resource templates"}`,
		...(failures.length && rows.length === 0 ? { errorKind: "mcp_resource_error" } : {}),
		metadata: { resourceCount: rows.length, failureCount: failures.length } };
}

function validIdentity(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !/[\0\r\n]/u.test(value);
}

function invalidArguments(): ToolAdapterResult { return failure("invalid_arguments", "Invalid MCP resource arguments or continuation."); }

function resourceFailure(error: unknown, signal: AbortSignal): ToolAdapterResult {
	if (signal.aborted || isMcpAbort(error)) throw error;
	const kind = error instanceof Error && error.message === "unknown_mcp_server" ? "unknown_mcp_server" : classifyMcpFailure(error);
	return failure(kind, "The MCP resource request failed.");
}

function failure(errorKind: string, message: string): ToolAdapterResult {
	return { success: false, modelOutput: `${message}\nError kind: ${errorKind}`, summary: "MCP resource unavailable", errorKind, metadata: {} };
}
