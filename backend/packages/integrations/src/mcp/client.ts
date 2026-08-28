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
import { INTEGRATIONS_VERSION } from "../version.ts";
import type {
	McpClientContract,
	McpContentItem,
	McpProtocolClient,
	McpResourceContent,
	McpResourceDescriptor,
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
	readonly #protocol: McpProtocolClient;
	#connectPromise?: Promise<void>;
	#closePromise?: Promise<void>;
	#closed = false;

	constructor(options: McpClientOptions) {
		this.config = options.config;
		this.#protocol = options.protocol ?? createSdkProtocol(options);
	}

	async listTools(signal: AbortSignal): Promise<readonly McpToolDescriptor[]> {
		return this.#run(signal, async () => {
			const result = await this.#protocol.listTools(signal);
			return Object.freeze(result.tools.flatMap((item) => {
				const name = stringValue(item.name);
				if (!name) return [];
				return [Object.freeze({
					serverId: this.config.id,
					name,
					description: stringValue(item.description) ?? "",
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
		return this.#run(signal, async () => {
			const result = await this.#protocol.callTool(name, argumentsValue, signal);
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
		return this.#run(signal, async () => {
			const result = await this.#protocol.listResources(signal);
			return Object.freeze(result.resources.flatMap((item) => {
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
		return this.#run(signal, async () => {
			const result = await this.#protocol.readResource(uri, signal);
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

	close(): Promise<void> {
		if (!this.#closePromise) {
			this.#closed = true;
			this.#closePromise = Promise.resolve().then(() => this.#protocol.close());
		}
		return this.#closePromise;
	}

	async #run<Value>(signal: AbortSignal, operation: () => Promise<Value>): Promise<Value> {
		try {
			await this.#connect(signal);
			return await operation();
		} catch (error) {
			if (isTimeoutError(error)) {
				if (this.config.transport === "stdio") await this.close().catch(() => undefined);
				throw error;
			}
			if (signal.aborted || isAbortError(error)) {
				if (this.config.transport === "stdio") await this.close().catch(() => undefined);
				if (!isAbortError(error)) throw abortError();
			}
			throw error;
		}
	}

	async #connect(signal: AbortSignal): Promise<void> {
		if (signal.aborted) throw abortError();
		if (this.#closed) throw new Error("mcp_client_closed");
		if (!this.#connectPromise) {
			this.#connectPromise = this.#protocol.connect(signal).catch((error: unknown) => {
				this.#connectPromise = undefined;
				throw error;
			});
		}
		await this.#connectPromise;
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

	async listTools(signal: AbortSignal): Promise<{
		readonly tools: readonly Readonly<Record<string, unknown>>[];
	}> {
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

	async listResources(signal: AbortSignal): Promise<{
		readonly resources: readonly Readonly<Record<string, unknown>>[];
	}> {
		const result = await this.#client.listResources({}, this.#requestOptions(signal));
		return { resources: result.resources as readonly Readonly<Record<string, unknown>>[] };
	}

	async readResource(uri: string, signal: AbortSignal): Promise<{
		readonly contents: readonly Readonly<Record<string, unknown>>[];
	}> {
		const result = await this.#client.readResource({ uri }, this.#requestOptions(signal));
		return { contents: result.contents as readonly Readonly<Record<string, unknown>>[] };
	}

	close(): Promise<void> {
		return this.#client.close();
	}

	#requestOptions(signal: AbortSignal): { readonly signal: AbortSignal; readonly timeout: number } {
		return { signal, timeout: this.#timeoutMs };
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
			options.sandboxProfile,
		);
		const stdio = new StdioClientTransport({
			command: launch.executable,
			args: [...launch.args],
			env: { ...config.env },
			stderr: "pipe",
			cwd: options.cwd ?? options.sandboxProfile.cwd,
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
				...(options.fetch ? { fetch: options.fetch } : {}),
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

function isAbortError(error: unknown): error is Error {
	return error instanceof Error && error.name === "AbortError";
}

function isTimeoutError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.name === "TimeoutError" || /timeout|timed out/iu.test(`${error.name} ${error.message}`);
}

function abortError(): Error {
	const error = new Error("interrupted");
	error.name = "AbortError";
	return error;
}
