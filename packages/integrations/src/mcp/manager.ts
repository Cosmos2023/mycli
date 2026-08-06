import type { IntegrationRegistration } from "../foundation/registration.ts";
import { classifyMcpFailure, isMcpAbort } from "./diagnostics.ts";
import { createMcpToolRegistration } from "./tool-adapter.ts";
import type {
	McpManagedClient,
	McpResourceContent,
	McpResourceDescriptor,
	McpServerConfig,
	McpServerDiscovery,
} from "./types.ts";

export interface McpManagerOptions {
	readonly configs: readonly McpServerConfig[];
	readonly createClient: (config: McpServerConfig) => McpManagedClient;
}

export interface McpManagerDiscovery {
	readonly registrations: readonly IntegrationRegistration[];
	readonly resources: readonly McpResourceDescriptor[];
	readonly servers: readonly McpServerDiscovery[];
}

export class McpManager {
	readonly #configs: readonly McpServerConfig[];
	readonly #createClient: (config: McpServerConfig) => McpManagedClient;
	readonly #clients = new Map<string, McpManagedClient>();
	readonly #lifecycles: McpManagedClient[] = [];
	#discoveryPromise?: Promise<McpManagerDiscovery>;
	#closePromise?: Promise<void>;
	#closed = false;

	constructor(options: McpManagerOptions) {
		this.#configs = Object.freeze([...options.configs].sort((left, right) => (
			compareText(left.id, right.id)
		)));
		this.#createClient = options.createClient;
	}

	discover(signal: AbortSignal): Promise<McpManagerDiscovery> {
		if (this.#closed) return Promise.reject(new Error("mcp_manager_closed"));
		this.#discoveryPromise ??= this.#discover(signal);
		return this.#discoveryPromise;
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
		const registrations: IntegrationRegistration[] = [];
		const resources: McpResourceDescriptor[] = [];
		const servers: McpServerDiscovery[] = [];
		try {
			for (const config of this.#configs) {
				if (signal.aborted) throw abortError();
				if (!config.enabled) {
					servers.push(serverResult(config, "disabled", 0, 0));
					continue;
				}
				let client: McpManagedClient | undefined;
				try {
					client = this.#createClient(config);
					const tools = await client.listTools(signal);
					const discoveredResources = await client.listResources(signal);
					registrations.push(...tools.map((tool) => createMcpToolRegistration(client!, tool)));
					resources.push(...discoveredResources);
					this.#clients.set(config.id, client);
					this.#lifecycles.push(client);
					servers.push(serverResult(config, "ok", tools.length, discoveredResources.length));
				} catch (error) {
					if (client) await closeIgnoringFailure(client);
					if (signal.aborted || isMcpAbort(error)) throw error;
					servers.push(serverResult(config, "failed", 0, 0, classifyMcpFailure(error)));
				}
			}
			return Object.freeze({
				registrations: Object.freeze(registrations),
				resources: Object.freeze(resources),
				servers: Object.freeze(servers),
			});
		} catch (error) {
			await this.close().catch(() => undefined);
			throw error;
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
