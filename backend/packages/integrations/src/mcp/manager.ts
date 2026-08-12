import type { IntegrationRegistration } from "../foundation/registration.ts";
import { classifyMcpFailure, isMcpAbort } from "./diagnostics.ts";
import { createMcpToolRegistration } from "./tool-adapter.ts";
import type {
	McpManagedClient,
	McpResourceContent,
	McpResourceDescriptor,
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
	readonly client?: McpManagedClient;
	readonly catalog?: McpCachedServerCatalog;
	readonly registrations: readonly IntegrationRegistration[];
	readonly resources: readonly McpResourceDescriptor[];
	readonly server: McpServerDiscovery;
}

export class McpManager {
	readonly #configs: readonly McpServerConfig[];
	readonly #createClient: (config: McpServerConfig) => McpManagedClient;
	readonly #catalogCache?: McpCatalogCacheContract;
	readonly #clients = new Map<string, McpManagedClient>();
	readonly #lifecycles: McpManagedClient[] = [];
	#cachePromise?: Promise<McpManagerDiscovery | undefined>;
	#refreshPromise?: Promise<McpManagerDiscovery>;
	#currentDiscovery?: McpManagerDiscovery;
	#closePromise?: Promise<void>;
	#closed = false;

	constructor(options: McpManagerOptions) {
		this.#configs = Object.freeze([...options.configs].sort((left, right) => (
			compareText(left.id, right.id)
		)));
		this.#createClient = options.createClient;
		this.#catalogCache = options.catalogCache;
	}

	discover(signal: AbortSignal): Promise<McpManagerDiscovery> {
		if (this.#closed) return Promise.reject(new Error("mcp_manager_closed"));
		if (this.#currentDiscovery) return Promise.resolve(this.#currentDiscovery);
		return this.#discover(signal);
	}

	loadCached(signal: AbortSignal): Promise<McpManagerDiscovery | undefined> {
		if (this.#closed) return Promise.reject(new Error("mcp_manager_closed"));
		this.#cachePromise ??= this.#loadCached(signal).then((discovery) => {
			if (discovery) this.#currentDiscovery ??= discovery;
			return discovery;
		});
		return this.#cachePromise;
	}

	refresh(signal: AbortSignal): Promise<McpManagerDiscovery> {
		if (this.#closed) return Promise.reject(new Error("mcp_manager_closed"));
		this.#refreshPromise ??= this.#discoverLive(signal).then((discovery) => {
			this.#currentDiscovery = discovery;
			return discovery;
		});
		return this.#refreshPromise;
	}

	async readResource(
		serverId: string,
		uri: string,
		signal: AbortSignal,
	): Promise<readonly McpResourceContent[]> {
		await this.discover(signal);
		const client = this.#clients.get(serverId);
		if (!client) throw new Error("unknown_mcp_server");
		return client.readResource(uri, signal);
	}

	close(): Promise<void> {
		if (!this.#closePromise) {
			this.#closed = true;
			this.#closePromise = this.#closeAll();
		}
		return this.#closePromise;
	}

	async #discover(signal: AbortSignal): Promise<McpManagerDiscovery> {
		try {
			const cached = await this.loadCached(signal);
			if (cached) return cached;
			return await this.refresh(signal);
		} catch (error) {
			await this.close().catch(() => undefined);
			throw error;
		}
	}

	async #discoverLive(signal: AbortSignal): Promise<McpManagerDiscovery> {
		const registrations: IntegrationRegistration[] = [];
		const resources: McpResourceDescriptor[] = [];
		const servers: McpServerDiscovery[] = [];
		const discoveredClients: McpManagedClient[] = [];
		try {
			const settled = await Promise.allSettled(
				this.#configs.map((config) => this.#discoverServer(config, signal)),
			);
			const rejected = settled.find(
				(result): result is PromiseRejectedResult => result.status === "rejected",
			);
			if (rejected) {
				await Promise.all(settled.flatMap((result) => (
					result.status === "fulfilled" && result.value.client
						? [closeIgnoringFailure(result.value.client)]
						: []
				)));
				throw rejected.reason;
			}
			for (const result of settled) {
				if (result.status !== "fulfilled") continue;
				const discovery = result.value;
				registrations.push(...discovery.registrations);
				resources.push(...discovery.resources);
				servers.push(discovery.server);
				if (discovery.client) {
					discoveredClients.push(discovery.client);
					this.#clients.set(discovery.server.serverId, discovery.client);
					this.#lifecycles.push(discovery.client);
				}
			}
			const result = Object.freeze({
				registrations: Object.freeze(registrations),
				resources: Object.freeze(resources),
				servers: Object.freeze(servers),
			});
			if (servers.every((server) => server.status !== "failed")) {
				const catalogs = settled.flatMap((entry) => (
					entry.status === "fulfilled" && entry.value.catalog ? [entry.value.catalog] : []
				));
				await this.#catalogCache?.save(this.#configs, catalogs).catch(() => undefined);
			}
			return result;
		} catch (error) {
			await Promise.all(discoveredClients.map(closeIgnoringFailure));
			for (const client of discoveredClients) {
				const lifecycleIndex = this.#lifecycles.indexOf(client);
				if (lifecycleIndex >= 0) this.#lifecycles.splice(lifecycleIndex, 1);
				for (const [serverId, current] of this.#clients) {
					if (current === client) this.#clients.delete(serverId);
				}
			}
			throw error;
		}
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
		const created: McpManagedClient[] = [];
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
				const client = this.#createClient(config);
				created.push(client);
				registrations.push(...catalog.tools.map(
					(tool) => createMcpToolRegistration(client, tool),
				));
				servers.push(serverResult(
					config,
					"ok",
					catalog.tools.length,
					catalog.resourceCount,
				));
				this.#clients.set(config.id, client);
				this.#lifecycles.push(client);
			}
			return Object.freeze({
				registrations: Object.freeze(registrations),
				resources: Object.freeze(resources),
				servers: Object.freeze(servers),
			});
		} catch (error) {
			await Promise.all(created.map(closeIgnoringFailure));
			this.#clients.clear();
			this.#lifecycles.length = 0;
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
		let client: McpManagedClient | undefined;
		try {
			client = this.#createClient(config);
			const [toolsResult, resourcesResult] = await Promise.allSettled([
				client.listTools(signal),
				client.listResources(signal),
			]);
			if (toolsResult.status === "rejected") throw toolsResult.reason;
			if (resourcesResult.status === "rejected") throw resourcesResult.reason;
			const tools = toolsResult.value;
			const resources = resourcesResult.value;
			return Object.freeze({
				client,
				catalog: serverCatalog(config.id, tools, resources.length),
				registrations: Object.freeze(
					tools.map((tool) => createMcpToolRegistration(client!, tool)),
				),
				resources,
				server: serverResult(config, "ok", tools.length, resources.length),
			});
		} catch (error) {
			if (client) await closeIgnoringFailure(client);
			if (signal.aborted || isMcpAbort(error)) throw error;
			return Object.freeze({
				registrations: Object.freeze([]),
				resources: Object.freeze([]),
				server: serverResult(config, "failed", 0, 0, classifyMcpFailure(error)),
			});
		}
	}

	async #closeAll(): Promise<void> {
		let failed = false;
		for (const client of [...this.#lifecycles].reverse()) {
			try {
				await client.close();
			} catch {
				failed = true;
			}
		}
		this.#lifecycles.length = 0;
		this.#clients.clear();
		if (failed) throw new Error("mcp_close_failed");
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

async function closeIgnoringFailure(client: McpManagedClient): Promise<void> {
	try {
		await client.close();
	} catch {
		// The failed server remains isolated from other discoveries.
	}
}

function abortError(): Error {
	const error = new Error("interrupted");
	error.name = "AbortError";
	return error;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
