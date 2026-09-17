import type { IntegrationRegistration } from "../foundation/registration.ts";
import { createErrorContext, failureScope } from "@mycli/contracts";
import { normalizeIntegrationToolNames } from "../foundation/tool-catalog.ts";
import { classifyMcpFailure, describeMcpFailure, isMcpAbort } from "./diagnostics.ts";
import { createMcpToolRegistration } from "./tool-adapter.ts";
import { SharedMcpOperation } from "./shared-operation.ts";
import { collectMcpPages } from "./pagination.ts";
import { mcpToolEnabled } from "./config-options.ts";
import type {
	McpManagedClient,
	McpDiscoveryFailure,
	McpResourceContent,
	McpResourceDescriptor,
	McpResourceFailure,
	McpResourceListing,
	McpResourcePage,
	McpResourceTemplateDescriptor,
	McpResourceTemplateListing,
	McpServerConfig,
	McpServerDiscovery,
	McpToolDescriptor,
} from "./types.ts";
import type {
	McpCachedServerCatalog,
	McpCatalogCacheContract,
} from "./catalog-cache.ts";

export interface McpManagerOptions {
	readonly configs: readonly McpServerConfig[];
	readonly createClient: (config: McpServerConfig) => McpManagedClient;
	readonly catalogCache?: McpCatalogCacheContract;
}

export interface McpManagerDiscovery {
	readonly registrations: readonly IntegrationRegistration[];
	readonly resources: readonly McpResourceDescriptor[];
	readonly servers: readonly McpServerDiscovery[];
}

interface McpServerDiscoveryResult {
	readonly catalog?: McpCachedServerCatalog;
	readonly registrations: readonly IntegrationRegistration[];
	readonly resources: readonly McpResourceDescriptor[];
	readonly server: McpServerDiscovery;
}

export class McpRequiredServerError extends Error {
	readonly code = "mcp_required_server_failed";
	readonly errorContext = createErrorContext({ reason: "integration.unavailable", source: "integration",
		scope: failureScope("request", "required-mcp-startup"), outcome: { state: "not_started", effects: "none" },
		details: { operation: "initialize", phase: "connect", legacy_kind: "mcp_required_server_failed" } });
	constructor(readonly servers: readonly string[]) {
		super(`Required MCP servers could not start: ${servers.filter((id) => /^[A-Za-z0-9._-]{1,64}$/u.test(id)).slice(0, 20).join(", ")}`);
	}
}

export class McpManager {
	readonly #configs: readonly McpServerConfig[];
	readonly #createClient: (config: McpServerConfig) => McpManagedClient;
	readonly #catalogCache?: McpCatalogCacheContract;
	readonly #clients = new Map<string, McpManagedClient>();
	readonly #cacheOperation = new SharedMcpOperation<McpManagerDiscovery | undefined>();
	readonly #refreshOperation = new SharedMcpOperation<McpManagerDiscovery>();
	readonly #requiredOperation = new SharedMcpOperation<McpManagerDiscovery>();
	#cached?: { readonly discovery: McpManagerDiscovery | undefined };
	#currentDiscovery?: McpManagerDiscovery;
	#closePromise?: Promise<void>;
	#closed = false;
	readonly #resourceController = new AbortController();
	readonly #resourceOperations = new Set<Promise<unknown>>();

	constructor(options: McpManagerOptions) {
		this.#configs = Object.freeze([...options.configs].sort((left, right) => (
			compareText(left.id, right.id)
		)));
		this.#createClient = options.createClient;
		this.#catalogCache = options.catalogCache;
	}

	discover(signal: AbortSignal): Promise<McpManagerDiscovery> {
		if (this.#closed) return Promise.reject(new Error("mcp_manager_closed"));
		if (signal.aborted) return Promise.reject(signal.reason);
		if (this.#currentDiscovery) return Promise.resolve(this.#currentDiscovery);
		return this.#discover(signal);
	}

	loadCached(signal: AbortSignal): Promise<McpManagerDiscovery | undefined> {
		if (this.#closed) return Promise.reject(new Error("mcp_manager_closed"));
		if (signal.aborted) return Promise.reject(signal.reason);
		if (this.#cached) return Promise.resolve(this.#cached.discovery);
		return this.#cacheOperation.run(signal, async (activeSignal) => {
			const discovery = await this.#loadCached(activeSignal);
			activeSignal.throwIfAborted();
			this.#cached = { discovery };
			if (discovery) this.#currentDiscovery ??= discovery;
			return discovery;
		});
	}

	refresh(signal: AbortSignal): Promise<McpManagerDiscovery> {
		if (this.#closed) return Promise.reject(new Error("mcp_manager_closed"));
		return this.#refreshOperation.run(signal, async (activeSignal) => {
			// A delayed cache read cannot replace a live catalog or create a second client.
			await this.loadCached(activeSignal);
			const discovery = await this.#discoverLive(activeSignal);
			activeSignal.throwIfAborted();
			this.#currentDiscovery = discovery;
			return discovery;
		});
	}

	discoverRequired(signal: AbortSignal): Promise<McpManagerDiscovery> {
		if (this.#closed) return Promise.reject(new Error("mcp_manager_closed"));
		return this.#requiredOperation.run(signal, async (activeSignal) => {
			await this.loadCached(activeSignal);
			const results = await Promise.all(this.#configs.filter((config) => config.enabled && config.required)
				.map((config) => this.#discoverServer(config, activeSignal)));
			activeSignal.throwIfAborted();
			const failed = results.filter(({ server }) => server.status === "failed"
				|| server.failures?.some((failure) => failure.capability === "tools" && !failure.tool));
			if (failed.length) throw new McpRequiredServerError(failed.map(({ server }) => server.serverId));
			return Object.freeze({ registrations: normalizeIntegrationToolNames(results.flatMap((result) => result.registrations)),
				resources: Object.freeze(results.flatMap((result) => result.resources)), servers: Object.freeze(results.map((result) => result.server)) });
		});
	}

	listResources(signal: AbortSignal, serverId?: string): Promise<McpResourceListing> {
		return this.#runResource(signal, async (activeSignal) => {
			const configs = this.#configs.filter((config) => config.enabled && (serverId === undefined || config.id === serverId));
			if (serverId && configs.length === 0) throw new Error("unknown_mcp_server");
			const resources: McpResourceDescriptor[] = [];
			const failures: McpResourceFailure[] = [];
			const settled = await Promise.allSettled(configs.map(async (config) => {
				const client = this.#clients.get(config.id);
				if (!client) throw new Error("mcp_server_unavailable");
				return client.listResources(activeSignal);
			}));
			activeSignal.throwIfAborted();
			settled.forEach((result, index) => {
				if (result.status === "fulfilled") resources.push(...result.value);
				else failures.push({ server: configs[index]!.id, errorKind: classifyMcpFailure(result.reason),
					diagnostic: describeMcpFailure(result.reason, { operation: "resources/list" }) });
			});
			return Object.freeze({ resources: Object.freeze(resources), failures: Object.freeze(failures) });
		});
	}

	readResource(
		serverId: string,
		uri: string,
		signal: AbortSignal,
	): Promise<readonly McpResourceContent[]> {
		return this.#runResource(signal, async (activeSignal) => {
			const client = this.#clients.get(serverId);
			if (!client) throw new Error("unknown_mcp_server");
			return client.readResource(uri, activeSignal);
		});
	}

	listResourcesPage(serverId: string, signal: AbortSignal, cursor?: string): Promise<McpResourcePage> {
		return this.#runResource(signal, async (activeSignal) => {
			const client = this.#clients.get(serverId);
			if (!client) throw new Error("unknown_mcp_server");
			if (client.listResourcesPage) return client.listResourcesPage(activeSignal, cursor);
			if (cursor !== undefined) throw new Error("invalid_mcp_resource_pagination");
			return { resources: await client.listResources(activeSignal) };
		});
	}

	listResourceTemplates(signal: AbortSignal, serverId?: string, cursor?: string): Promise<McpResourceTemplateListing> {
		return this.#runResource(signal, async (activeSignal) => {
			if (cursor !== undefined && serverId === undefined) throw new Error("invalid_mcp_resource_pagination");
			const configs = this.#configs.filter((config) => config.enabled && (serverId === undefined || config.id === serverId));
			if (serverId && configs.length === 0) throw new Error("unknown_mcp_server");
			const resourceTemplates: McpResourceTemplateDescriptor[] = [];
			const failures: McpResourceFailure[] = [];
			const settled = await Promise.allSettled(configs.map(async (config) => {
				const client = this.#clients.get(config.id);
				if (!client) throw new Error("mcp_server_unavailable");
				if (serverId !== undefined) return client.listResourceTemplates?.(activeSignal, cursor) ?? { resourceTemplates: [] };
				const templates = await collectMcpPages(activeSignal, async (next) => {
					const page = await client.listResourceTemplates?.(activeSignal, next) ?? { resourceTemplates: [] };
					return { items: page.resourceTemplates, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
				}, "invalid_mcp_resource_pagination");
				return { resourceTemplates: templates };
			}));
			activeSignal.throwIfAborted();
			let nextCursor: string | undefined;
			settled.forEach((result, index) => {
				if (result.status === "fulfilled") {
					resourceTemplates.push(...result.value.resourceTemplates);
					nextCursor = result.value.nextCursor;
				} else failures.push({ server: configs[index]!.id, errorKind: classifyMcpFailure(result.reason),
					diagnostic: describeMcpFailure(result.reason, { operation: "resources/templates/list" }) });
			});
			return { resourceTemplates, failures, ...(nextCursor === undefined ? {} : { nextCursor }) };
		});
	}

	async #runResource<Value>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<Value>): Promise<Value> {
		if (this.#closed) throw new Error("mcp_manager_closed");
		const activeSignal = AbortSignal.any([signal, this.#resourceController.signal]);
		activeSignal.throwIfAborted();
		// Discovery owns startup cleanup; only track resource IO after it completes.
		await this.discover(activeSignal);
		const pending = Promise.resolve().then(async () => {
			activeSignal.throwIfAborted();
			const value = await operation(activeSignal);
			activeSignal.throwIfAborted();
			return value;
		});
		this.#resourceOperations.add(pending);
		void pending.then(() => this.#resourceOperations.delete(pending), () => this.#resourceOperations.delete(pending));
		return pending;
	}

	close(): Promise<void> {
		if (!this.#closePromise) {
			this.#closed = true;
			this.#resourceController.abort();
			this.#closePromise = this.#closeAll();
		}
		return this.#closePromise;
	}

	async #discover(signal: AbortSignal): Promise<McpManagerDiscovery> {
		const cached = await this.loadCached(signal);
		return cached ?? await this.refresh(signal);
	}

	#getClient(config: McpServerConfig): McpManagedClient {
		if (this.#closed) throw new Error("mcp_manager_closed");
		let client = this.#clients.get(config.id);
		if (!client) {
			client = this.#createClient(config);
			this.#clients.set(config.id, client);
		}
		return client;
	}

	async #discoverLive(signal: AbortSignal): Promise<McpManagerDiscovery> {
		const settled = await Promise.allSettled(this.#configs.map((config) => this.#discoverServer(config, signal)));
		signal.throwIfAborted();
		const discoveries = settled.map((entry) => {
			if (entry.status === "rejected") throw entry.reason;
			return entry.value;
		});
		const result: McpManagerDiscovery = Object.freeze({
			registrations: normalizeIntegrationToolNames(discoveries.flatMap((discovery) => discovery.registrations)),
			resources: Object.freeze(discoveries.flatMap((discovery) => discovery.resources)),
			servers: Object.freeze(discoveries.map((discovery) => discovery.server)),
		});
		if (result.servers.every((server) => server.status === "ok" || server.status === "disabled")) {
			const catalogs = discoveries.flatMap((discovery) => discovery.catalog ? [discovery.catalog] : []);
			await this.#catalogCache?.save(this.#configs, catalogs).catch(() => undefined);
		}
		signal.throwIfAborted();
		return result;
	}

	async #loadCached(signal: AbortSignal): Promise<McpManagerDiscovery | undefined> {
		if (!this.#catalogCache) return undefined;
		const catalogs = await this.#catalogCache.load(this.#configs).catch(() => undefined);
		if (!catalogs || signal.aborted) {
			if (signal.aborted) throw abortError();
			return undefined;
		}
		const byServer = new Map(catalogs.map((catalog) => [catalog.serverId, catalog]));
		const expected = this.#configs.filter((config) => config.enabled);
		if (catalogs.length !== expected.length
			|| expected.some((config) => !byServer.has(config.id))) {
			return undefined;
		}
		try {
			const registrations: IntegrationRegistration[] = [];
			const resources: McpResourceDescriptor[] = [];
			const servers: McpServerDiscovery[] = [];
			for (const config of this.#configs) {
				if (signal.aborted) throw abortError();
				if (!config.enabled) {
					servers.push(serverResult(config, "disabled", 0, 0));
					continue;
				}
				const catalog = byServer.get(config.id)!;
				const client = this.#getClient(config);
				const tools = catalog.tools.filter((tool) => mcpToolEnabled(config, tool.name));
				registrations.push(...tools.map(
					(tool) => createMcpToolRegistration(client, tool, config),
				));
				servers.push(serverResult(
					config,
					"ok",
					tools.length,
					catalog.resourceCount,
				));
			}
			return Object.freeze({
				registrations: normalizeIntegrationToolNames(registrations),
				resources: Object.freeze(resources),
				servers: Object.freeze(servers),
			});
		} catch (error) {
			if (signal.aborted || isMcpAbort(error)) throw error;
			return undefined;
		}
	}

	async #discoverServer(
		config: McpServerConfig,
		signal: AbortSignal,
	): Promise<McpServerDiscoveryResult> {
		if (signal.aborted) throw abortError();
		if (!config.enabled) {
			return Object.freeze({
				registrations: Object.freeze([]),
				resources: Object.freeze([]),
				server: serverResult(config, "disabled", 0, 0),
			});
		}
		try {
			const client = this.#getClient(config);
			const [toolsResult, resourcesResult] = await Promise.allSettled([
				client.listTools(signal), client.listResources(signal),
			]);
			signal.throwIfAborted();
			const failures: McpDiscoveryFailure[] = [];
			const tools = toolsResult.status === "fulfilled" ? toolsResult.value : [];
			const resources = resourcesResult.status === "fulfilled" ? resourcesResult.value : [];
			if (toolsResult.status === "rejected") failures.push({ capability: "tools", category: classifyMcpFailure(toolsResult.reason) });
			if (resourcesResult.status === "rejected") failures.push({ capability: "resources", category: classifyMcpFailure(resourcesResult.reason) });
			const registrations: IntegrationRegistration[] = [];
			for (const tool of tools) {
				if (!mcpToolEnabled(config, tool.name)) continue;
				try {
					registrations.push(createMcpToolRegistration(client, tool, config));
				} catch (error) {
					failures.push({ capability: "tools", category: classifyMcpFailure(error),
						tool: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(tool.name) ? tool.name : "tool" });
				}
			}
			const status = failures.length === 0 ? "ok"
				: registrations.length > 0 || resources.length > 0 ? "partial" : "failed";
			return Object.freeze({
				catalog: serverCatalog(config.id, tools, resources.length),
				registrations: Object.freeze(registrations), resources,
				server: Object.freeze({
					...serverResult(config, status, registrations.length, resources.length, failures[0]?.category),
					...(failures.length ? { failures: Object.freeze(failures.slice(0, 20).map((failure) => Object.freeze(failure))),
						failureCount: failures.length } : {}),
				}),
			});
		} catch (error) {
			if (signal.aborted || isMcpAbort(error)) throw error;
			return Object.freeze({
				registrations: Object.freeze([]), resources: Object.freeze([]),
				server: serverResult(config, "failed", 0, 0, classifyMcpFailure(error)),
			});
		}
	}

	async #closeAll(): Promise<void> {
		await Promise.allSettled([
			this.#refreshOperation.close(), this.#requiredOperation.close(), this.#cacheOperation.close(), ...this.#resourceOperations,
		]);
		const results = await Promise.allSettled([...this.#clients.values()].reverse().map((client) => client.close()));
		this.#clients.clear();
		if (results.some((result) => result.status === "rejected")) throw new Error("mcp_close_failed");
	}
}

function serverCatalog(
	serverId: string,
	tools: readonly McpToolDescriptor[],
	resourceCount: number,
): McpCachedServerCatalog {
	return Object.freeze({
		serverId,
		tools: Object.freeze([...tools]),
		resourceCount,
	});
}

function serverResult(
	config: McpServerConfig,
	status: McpServerDiscovery["status"],
	toolCount: number,
	resourceCount: number,
	failureCategory?: string,
): McpServerDiscovery {
	return Object.freeze({
		serverId: config.id,
		transport: config.transport,
		enabled: config.enabled,
		status,
		toolCount,
		resourceCount,
		timeoutMs: config.timeoutMs,
		...(failureCategory ? { failureCategory } : {}),
	});
}

function abortError(): Error {
	const error = new Error("interrupted");
	error.name = "AbortError";
	return error;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
