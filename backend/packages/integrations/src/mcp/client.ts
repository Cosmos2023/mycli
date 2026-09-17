import { Client as SdkClient } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpElicitationCoordinator, type McpElicitationHandler, type McpInvocationContext } from "./elicitation.ts";
import type { SandboxProfile } from "@mycli/tools";
import { McpConnection } from "./connection.ts";
import { createMcpTransport, type McpTransportLease } from "./sdk-transport.ts";
import { collectMcpPages } from "./pagination.ts";
import { parseMcpAnnotations } from "./config-options.ts";
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
	readonly createProtocol?: () => McpProtocolClient;
	readonly sandboxProfile?: SandboxProfile;
	readonly cwd?: string;
	readonly homeDir?: string;
	readonly onElicitation?: McpElicitationHandler;
	readonly fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

export class McpClient implements McpClientContract {
	readonly config: McpServerConfig;
	readonly #connection: McpConnection;

	constructor(options: McpClientOptions) {
		this.config = options.config;
		this.#connection = new McpConnection({ createProtocol: options.createProtocol ?? (() => options.protocol ?? new SdkProtocolClient(options)),
			transport: options.config.transport, timeoutMs: options.config.timeoutMs,
			startupTimeoutMs: options.config.startupTimeoutMs, toolTimeoutMs: options.config.toolTimeoutMs,
			recoverSession: options.protocol === undefined && options.config.transport === "streamable_http" });
	}

	async listTools(signal: AbortSignal): Promise<readonly McpToolDescriptor[]> {
		return this.#connection.run("tools/list", signal, async (protocol, activeSignal) => {
			const tools = await collectMcpPages(activeSignal, async (cursor) => {
				const page = await protocol.listTools(activeSignal, cursor);
				return { items: page.tools, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
			}, "invalid_mcp_tool_pagination");
			const names = new Set<string>();
			const serverInstructions = [this.config.pluginDescription, protocol.getInstructions?.()?.trim()]
				.filter(Boolean).join("\n").slice(0, 4_096);
			return Object.freeze(tools.flatMap((item) => {
				const name = stringValue(item.name);
				if (!name) return [];
				if (names.has(name)) throw new Error("invalid_mcp_tool_pagination");
				names.add(name);
				const annotations = parseMcpAnnotations(item.annotations);
				return [Object.freeze({
					serverId: this.config.id,
					name,
					description: stringValue(item.description) ?? "",
					...(serverInstructions ? { serverInstructions } : {}),
					inputSchema: frozenRecord(item.inputSchema),
					supportsParallelToolCalls: this.config.supportsParallelToolCalls
						|| readOnlyHint(item.annotations),
					...(annotations ? { annotations } : {}),
				})];
			}));
		});
	}

	async callTool(
		name: string,
		argumentsValue: Readonly<Record<string, unknown>>,
		signal: AbortSignal,
		context?: McpInvocationContext,
	): Promise<McpToolCallResult> {
		return this.#connection.run("tools/call", signal, async (protocol, activeSignal, pauseTimeout) => {
			const result = await protocol.callTool(name, argumentsValue, activeSignal, context ? { ...context, pauseTimeout } : undefined);
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
			const resources = await collectMcpPages(activeSignal, async (cursor) => {
				const page = await protocol.listResources(activeSignal, cursor);
				return { items: page.resources, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
			}, "invalid_mcp_resource_pagination");
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
	readonly #client: SdkClient;
	readonly #elicitation?: McpElicitationCoordinator;
	readonly #options: McpClientOptions;
	#transport?: Promise<McpTransportLease>;
	#closing?: Promise<void>;
	readonly #startupTimeoutMs: number;
	readonly #toolTimeoutMs: number;

	constructor(options: McpClientOptions) {
		this.#options = options;
		this.#client = new SdkClient({ name: "mycli", version: INTEGRATIONS_VERSION },
			{ capabilities: options.onElicitation ? { elicitation: { form: {}, url: {} } } : {} });
		if (options.onElicitation) {
			this.#elicitation = new McpElicitationCoordinator(options.config.id, options.onElicitation);
			this.#client.setRequestHandler(ElicitRequestSchema, (request, extra) => this.#elicitation!.request(request.params, extra.signal));
			this.#client.onclose = () => this.#elicitation?.close();
		}
		const { config } = options;
		this.#startupTimeoutMs = config.startupTimeoutMs ?? config.timeoutMs;
		this.#toolTimeoutMs = config.toolTimeoutMs ?? config.timeoutMs;
	}

	async connect(signal: AbortSignal): Promise<void> {
		if (this.#closing) throw new Error("mcp_client_closed");
		this.#transport = createMcpTransport(this.#options, signal);
		const lease = await this.#transport;
		signal.throwIfAborted();
		if (this.#closing) throw new Error("mcp_client_closed");
		await this.#client.connect(lease.transport, this.#requestOptions(signal));
	}

	getInstructions(): string | undefined {
		return this.#client.getInstructions();
	}

	isConnected(): boolean { return this.#client.transport !== undefined; }

	async listTools(signal: AbortSignal, cursor?: string): Promise<{
		readonly tools: readonly Readonly<Record<string, unknown>>[];
		readonly nextCursor?: string;
	}> {
		if (!this.#client.getServerCapabilities()?.tools) return { tools: [] };
		const result = await this.#client.listTools(cursor === undefined ? {} : { cursor }, this.#requestOptions(signal));
		return { tools: result.tools as readonly Readonly<Record<string, unknown>>[],
			...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }) };
	}

	async callTool(
		name: string,
		argumentsValue: Readonly<Record<string, unknown>>,
		signal: AbortSignal,
		context?: McpInvocationContext,
	): Promise<Readonly<Record<string, unknown>>> {
		const leave = this.#elicitation?.enter(context, signal);
		try { return await this.#client.callTool(
			{ name, arguments: { ...argumentsValue } },
			undefined,
			{ ...this.#requestOptions(signal, true), ...(this.#elicitation ? { timeout: 2_147_483_647 } : {}) },
		) as Readonly<Record<string, unknown>>;
		} finally { leave?.(); }
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
		const result = await this.#client.readResource({ uri }, this.#requestOptions(signal, true));
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
		this.#elicitation?.close();
		return this.#closing ??= (async () => {
			const lease = await this.#transport?.catch(() => undefined);
			try { await this.#client.close(); } finally { await lease?.close(); }
		})();
	}

	#requestOptions(signal: AbortSignal, invocation = false): { readonly signal: AbortSignal; readonly timeout: number } {
		return { signal, timeout: invocation ? this.#toolTimeoutMs : this.#startupTimeoutMs };
	}
}

function validateCursor(cursor: string | undefined, previous?: string): void {
	if (cursor !== undefined && (typeof cursor !== "string" || !cursor || cursor.length > 4_096 || cursor === previous)) {
		throw new Error("invalid_mcp_resource_pagination");
	}
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
