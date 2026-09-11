import { discoverMcpConfig } from "./config.ts";
import { McpManager } from "./manager.ts";
import type {
	McpManagedClient,
	McpServerConfig,
	McpServerDiscovery,
} from "./types.ts";

export interface McpManagementRow {
	readonly serverId: string;
	readonly transport: McpServerConfig["transport"];
	readonly enabled: boolean;
	readonly status: McpServerDiscovery["status"];
	readonly toolCount: number;
	readonly timeoutMs: number;
	readonly failureCategory?: string;
}

export interface McpManagementResponse {
	readonly ok: boolean;
	readonly action: "list" | "inspect" | "usage";
	readonly message: string;
	readonly servers: readonly McpManagementRow[];
	readonly issues: readonly string[];
}

export interface McpManagementServiceOptions {
	readonly workspaceRoot: string;
	readonly homeDir: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly includeRepository?: boolean;
	readonly createClient: (config: McpServerConfig) => McpManagedClient;
}

export class McpManagementService {
	readonly #options: McpManagementServiceOptions;

	constructor(options: McpManagementServiceOptions) {
		this.#options = options;
	}

	async list(signal: AbortSignal): Promise<McpManagementResponse> {
		const result = await this.#discover(signal);
		return response(
			result.ok,
			"list",
			`mcp: ${result.rows.length} configured`,
			result.rows,
			result.issues,
		);
	}

	async inspect(serverId: string, signal: AbortSignal): Promise<McpManagementResponse> {
		const result = await this.#discover(signal);
		const row = result.rows.find((item) => item.serverId === serverId);
		return response(
			result.ok && row !== undefined && row.status !== "failed",
			"inspect",
			row ? `mcp server: ${row.serverId}` : `mcp server not found: ${boundedId(serverId)}`,
			row ? [row] : [],
			result.issues,
		);
	}

	usage(): McpManagementResponse {
		return response(
			true,
			"usage",
			"usage: mycli mcp <list|inspect <server>|usage>",
			[],
			[],
		);
	}

	async #discover(signal: AbortSignal): Promise<{
		readonly ok: boolean;
		readonly rows: readonly McpManagementRow[];
		readonly issues: readonly string[];
	}> {
		const config = await discoverMcpConfig(this.#options);
		const issues = config.diagnostics.map((item) => (
			`${item.source}:${item.fileLabel}:${item.serverId}:${item.errorClass}`
		));
		const manager = new McpManager({
			configs: config.servers,
			createClient: this.#options.createClient,
		});
		let discovery;
		try {
			discovery = await manager.discover(signal);
		} finally {
			try {
				await manager.close();
			} catch {
				issues.push("mcp:cleanup_failed");
			}
		}
		const rows = discovery.servers.map(managementRow);
		return Object.freeze({
			ok: issues.length === 0 && rows.every((row) => row.status !== "failed"),
			rows: Object.freeze(rows),
			issues: Object.freeze(issues),
		});
	}
}

function managementRow(server: McpServerDiscovery): McpManagementRow {
	return Object.freeze({
		serverId: server.serverId,
		transport: server.transport,
		enabled: server.enabled,
		status: server.status,
		toolCount: server.toolCount,
		timeoutMs: server.timeoutMs,
		...(server.failureCategory ? { failureCategory: server.failureCategory } : {}),
	});
}

function response(
	ok: boolean,
	action: McpManagementResponse["action"],
	message: string,
	servers: readonly McpManagementRow[],
	issues: readonly string[],
): McpManagementResponse {
	return Object.freeze({
		ok,
		action,
		message,
		servers: Object.freeze([...servers]),
		issues: Object.freeze([...issues]),
	});
}

function boundedId(value: string): string {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value) ? value : "server";
}
