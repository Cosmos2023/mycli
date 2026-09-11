import { Client as SdkClient } from "@modelcontextprotocol/sdk/client/index.js";
import {
	StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
	prepareSandboxedProcess,
	type SandboxProfile,
} from "@mycli/tools";
import { LegacyHttpTransport } from "./legacy-http-transport.ts";
import { McpConnection } from "./connection.ts";
import { diagnosticMcpFetch } from "./http-fetch.ts";
import { INTEGRATIONS_VERSION } from "../version.ts";
import type {
	McpClientContract,
	McpContentItem,
	McpProtocolClient,
	McpResourceContent,
	McpResourceDescriptor,
	McpResourcePage,
	McpResourceTemplatePage,
	McpServerConfig,
	McpToolCallResult,
	McpToolDescriptor,
} from "./types.ts";

export interface McpClientOptions {
	readonly config: McpServerConfig;
	readonly protocol?: McpProtocolClient;
	readonly sandboxProfile?: SandboxProfile;
	readonly cwd?: string;
	readonly fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

export class McpClient implements McpClientContract {
	readonly config: McpServerConfig;
	readonly #connection: McpConnection;

	constructor(options: McpClientOptions) {
		this.config = options.config;
		this.#connection = new McpConnection({ createProtocol: () => options.protocol ?? createSdkProtocol(options),
			transport: options.config.transport, timeoutMs: options.config.timeoutMs,
			recoverSession: options.protocol === undefined && options.config.transport === "streamable_http" });
	}

	async listTools(signal: AbortSignal): Promise<readonly McpToolDescriptor[]> {
		return this.#connection.run("tools/list", signal, async (protocol, activeSignal) => {
			const result = await protocol.listTools(activeSignal);
			const serverInstructions = [this.config.pluginDescription, protocol.getInstructions?.()?.trim()]
				.filter(Boolean).join("\n").slice(0, 4_096);
			return Object.freeze(result.tools.flatMap((item) => {
				const name = stringValue(item.name);
				if (!name) return [];
				return [Object.freeze({
					serverId: this.config.id,
					name,
					description: stringValue(item.description) ?? "",
					...(serverInstructions ? { serverInstructions } : {}),
					inputSchema: frozenRecord(item.inputSchema),
					supportsParallelToolCalls: this.config.supportsParallelToolCalls
						|| readOnlyHint(item.annotations),
				})];
			}));
		});
	}

	async callTool(
		name: string,
		argumentsValue: Readonly<Record<string, unknown>>,
		signal: AbortSignal,
	): Promise<McpToolCallResult> {
		return this.#connection.run("tools/call", signal, async (protocol, activeSignal) => {
			const result = await protocol.callTool(name, argumentsValue, activeSignal);
			return Object.freeze({
				content: normalizeContent(result.content),
				...(result.structuredContent === undefined
					? {}
					: { structuredContent: result.structuredContent }),
				isError: result.isError === true,
			});
		});
	}

	async listResources(signal: AbortSignal): Promise<readonly McpResourceDescriptor[]> {
		return this.#connection.run("resources/list", signal, async (protocol, activeSignal) => {
			const resources: Readonly<Record<string, unknown>>[] = [];
			const seen = new Set<string>();
			let cursor: string | undefined;
			do {
				activeSignal.throwIfAborted();
				const page = await protocol.listResources(activeSignal, cursor);
				resources.push(...page.resources);
				cursor = page.nextCursor;
				if (resources.length > 10_000 || seen.size >= 100
					|| (cursor !== undefined && (typeof cursor !== "string" || !cursor || cursor.length > 4_096 || seen.has(cursor)))) {
					throw new Error("invalid_mcp_resource_pagination");
				}
				if (cursor) seen.add(cursor);
			} while (cursor !== undefined);
			return Object.freeze(resources.flatMap((item) => {
				const uri = stringValue(item.uri);
				if (!uri) return [];
				return [Object.freeze({
					serverId: this.config.id,
					uri,
					name: stringValue(item.name) ?? uri,
					description: stringValue(item.description) ?? "",
					...(stringValue(item.mimeType) ? { mimeType: stringValue(item.mimeType) } : {}),
				})];
			}));
		});
	}

	async readResource(uri: string, signal: AbortSignal): Promise<readonly McpResourceContent[]> {
		return this.#connection.run("resources/read", signal, async (protocol, activeSignal) => {
			const result = await protocol.readResource(uri, activeSignal);
			return Object.freeze(result.contents.flatMap((item) => {
				const itemUri = stringValue(item.uri);
				if (!itemUri) return [];
				return [Object.freeze({
					serverId: this.config.id,
					uri: itemUri,
					...(stringValue(item.mimeType) ? { mimeType: stringValue(item.mimeType) } : {}),
					...(stringValue(item.text) !== undefined ? { text: stringValue(item.text) } : {}),
					...(stringValue(item.blob) !== undefined ? { blob: stringValue(item.blob) } : {}),
				})];
			}));
		});
	}

	async listResourcesPage(signal: AbortSignal, cursor?: string): Promise<McpResourcePage> {
		return this.#connection.run("resources/list", signal, async (protocol, activeSignal) => {
			validateCursor(cursor);
			const page = await protocol.listResources(activeSignal, cursor);
			validateCursor(page.nextCursor, cursor);
			if (page.resources.length > 10_000) throw new Error("invalid_mcp_resource_pagination");
			return { resources: page.resources.flatMap((item) => {
				const uri = stringValue(item.uri);
				return uri ? [{ serverId: this.config.id, uri, name: stringValue(item.name) ?? uri,
					description: stringValue(item.description) ?? "",
					...(stringValue(item.mimeType) ? { mimeType: stringValue(item.mimeType) } : {}) }] : [];
			}), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
		});
	}

	async listResourceTemplates(signal: AbortSignal, cursor?: string): Promise<McpResourceTemplatePage> {
		return this.#connection.run("resources/templates/list", signal, async (protocol, activeSignal) => {
			validateCursor(cursor);
			const page = await protocol.listResourceTemplates?.(activeSignal, cursor) ?? { resourceTemplates: [] };
			validateCursor(page.nextCursor, cursor);
			if (page.resourceTemplates.length > 10_000) throw new Error("invalid_mcp_resource_pagination");
			return { resourceTemplates: page.resourceTemplates.flatMap((item) => {
				const uriTemplate = stringValue(item.uriTemplate);
				return uriTemplate ? [{ serverId: this.config.id, uriTemplate,
					name: stringValue(item.name) ?? uriTemplate, description: stringValue(item.description) ?? "",
					...(stringValue(item.mimeType) ? { mimeType: stringValue(item.mimeType) } : {}) }] : [];
			}), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
		});
	}

	close(): Promise<void> {
		return this.#connection.close();
	}
}

class SdkProtocolClient implements McpProtocolClient {
	readonly #client = new SdkClient({ name: "mycli", version: INTEGRATIONS_VERSION });
	readonly #transport: Transport;
	readonly #timeoutMs: number;

	constructor(transport: Transport, timeoutMs: number) {
		this.#transport = transport;
		this.#timeoutMs = timeoutMs;
	}

	connect(signal: AbortSignal): Promise<void> {
		return this.#client.connect(this.#transport, this.#requestOptions(signal));
	}

	getInstructions(): string | undefined {
		return this.#client.getInstructions();
	}

	async listTools(signal: AbortSignal): Promise<{
		readonly tools: readonly Readonly<Record<string, unknown>>[];
	}> {
		if (!this.#client.getServerCapabilities()?.tools) return { tools: [] };
		const result = await this.#client.listTools({}, this.#requestOptions(signal));
		return { tools: result.tools as readonly Readonly<Record<string, unknown>>[] };
	}

	async callTool(
		name: string,
		argumentsValue: Readonly<Record<string, unknown>>,
		signal: AbortSignal,
	): Promise<Readonly<Record<string, unknown>>> {
		return await this.#client.callTool(
			{ name, arguments: { ...argumentsValue } },
			undefined,
			this.#requestOptions(signal),
		) as Readonly<Record<string, unknown>>;
	}

	async listResources(signal: AbortSignal, cursor?: string): Promise<{
		readonly resources: readonly Readonly<Record<string, unknown>>[];
		readonly nextCursor?: string;
	}> {
		if (!this.#client.getServerCapabilities()?.resources) return { resources: [] };
		const result = await this.#client.listResources(cursor === undefined ? {} : { cursor }, this.#requestOptions(signal));
		return { resources: result.resources as readonly Readonly<Record<string, unknown>>[],
			...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }) };
	}

	async readResource(uri: string, signal: AbortSignal): Promise<{
		readonly contents: readonly Readonly<Record<string, unknown>>[];
	}> {
		const result = await this.#client.readResource({ uri }, this.#requestOptions(signal));
		return { contents: result.contents as readonly Readonly<Record<string, unknown>>[] };
	}

	async listResourceTemplates(signal: AbortSignal, cursor?: string): Promise<{
		readonly resourceTemplates: readonly Readonly<Record<string, unknown>>[];
		readonly nextCursor?: string;
	}> {
		if (!this.#client.getServerCapabilities()?.resources) return { resourceTemplates: [] };
		const result = await this.#client.listResourceTemplates(cursor === undefined ? {} : { cursor }, this.#requestOptions(signal));
		return { resourceTemplates: result.resourceTemplates,
			...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }) };
	}

	close(): Promise<void> {
		return this.#client.close();
	}

	#requestOptions(signal: AbortSignal): { readonly signal: AbortSignal; readonly timeout: number } {
		return { signal, timeout: this.#timeoutMs };
	}
}

function validateCursor(cursor: string | undefined, previous?: string): void {
	if (cursor !== undefined && (typeof cursor !== "string" || !cursor || cursor.length > 4_096 || cursor === previous)) {
		throw new Error("invalid_mcp_resource_pagination");
	}
}

function createSdkProtocol(options: McpClientOptions): McpProtocolClient {
	const { config } = options;
	let transport: Transport;
	if (config.transport === "stdio") {
		if (!config.command) throw new Error("mcp_stdio_command_required");
		if (!options.sandboxProfile) throw new Error("mcp_sandbox_required");
		const launch = prepareSandboxedProcess(
			[config.command, ...config.args],
			{ ...options.sandboxProfile, cwd: config.cwd ?? options.cwd ?? options.sandboxProfile.cwd },
		);
		const stdio = new StdioClientTransport({
			command: launch.executable,
			args: [...launch.args],
			env: { ...config.env },
			stderr: "pipe",
			cwd: config.cwd ?? options.cwd ?? options.sandboxProfile.cwd,
			maxBufferSize: 1_048_576,
		});
		stdio.stderr?.on("data", () => undefined);
		transport = stdio;
	} else {
		if (!config.url) throw new Error("mcp_remote_url_required");
		const url = new URL(config.url);
		transport = config.transport === "streamable_http"
			? new StreamableHTTPClientTransport(url, {
				requestInit: { headers: { ...config.headers } },
				fetch: diagnosticMcpFetch(options.fetch),
			})
			: new LegacyHttpTransport({
				url,
				headers: config.headers,
				...(options.fetch ? { fetch: options.fetch } : {}),
			});
	}
	return new SdkProtocolClient(transport, config.timeoutMs);
}

function normalizeContent(value: unknown): readonly McpContentItem[] {
	if (!Array.isArray(value)) return Object.freeze([]);
	return Object.freeze(value.flatMap((item) => {
		if (!isRecord(item) || typeof item.type !== "string") return [];
		return [Object.freeze({ ...item }) as McpContentItem];
	}));
}

function frozenRecord(value: unknown): Readonly<Record<string, unknown>> {
	return Object.freeze(isRecord(value) ? { ...value } : {});
}

function readOnlyHint(value: unknown): boolean {
	return isRecord(value) && value.readOnlyHint === true;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
