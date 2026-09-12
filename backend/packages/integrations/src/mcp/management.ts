import { discoverMcpConfig } from "./config.ts";
import { discoverConfiguredMcpServers, mcpServerSelector } from "./configured-servers.ts";
import { McpManager } from "./manager.ts";
import { McpConfigStore } from "./config-store.ts";
import { McpConfigError } from "./config.ts";
import { IntegrationToolApprovalStore } from "../foundation/tool-approval-store.ts";
import { loginMcpOAuth } from "./oauth-login.ts";
import { McpOAuthStore, McpOAuthError } from "./oauth-store.ts";
import type { McpOAuthFetch } from "./oauth-provider.ts";
import type {
	McpManagedClient,
	McpServerConfig,
	McpServerDiscovery,
} from "./types.ts";

export interface McpManagementRow {
	readonly serverId: string;
	readonly selector: string;
	readonly pluginId?: string;
	readonly pluginServerName?: string;
	readonly authStatus: "unsupported" | "configured_header" | "oauth" | "not_logged_in" | "unavailable";
	readonly transport: McpServerConfig["transport"];
	readonly enabled: boolean;
	readonly status: McpServerDiscovery["status"];
	readonly toolCount: number;
	readonly timeoutMs: number;
	readonly startupTimeoutMs: number;
	readonly toolTimeoutMs: number;
	readonly required: boolean;
	readonly source?: McpServerConfig["source"];
	readonly defaultToolsApprovalMode: NonNullable<McpServerConfig["defaultToolsApprovalMode"]>;
	readonly enabledTools?: readonly string[];
	readonly disabledTools?: readonly string[];
	readonly failureCategory?: string;
}

export interface McpManagementResponse {
	readonly ok: boolean;
	readonly action: "list" | "inspect" | "usage" | "add" | "remove" | "approvals" | "revoke" | "login" | "logout";
	readonly message: string;
	readonly servers: readonly McpManagementRow[];
	readonly issues: readonly string[];
	readonly approvals?: readonly { readonly id: string }[];
}

export interface McpManagementServiceOptions {
	readonly workspaceRoot: string;
	readonly homeDir: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly includeRepository?: boolean;
	readonly createClient: (config: McpServerConfig) => McpManagedClient;
	readonly oauthFetch?: (config: McpServerConfig) => McpOAuthFetch;
	readonly onAuthorization?: (url: string, signal: AbortSignal) => void | Promise<void>;
}

export class McpManagementService {
	readonly #options: McpManagementServiceOptions;

	constructor(options: McpManagementServiceOptions) {
		this.#options = options;
	}

	async login(serverId: string, signal: AbortSignal): Promise<McpManagementResponse> {
		return this.#auth("login", serverId, signal);
	}

	async logout(serverId: string, signal: AbortSignal): Promise<McpManagementResponse> {
		return this.#auth("logout", serverId, signal);
	}

	async #auth(action: "login" | "logout", serverId: string, signal: AbortSignal): Promise<McpManagementResponse> {
		try {
			const config = (await discoverConfiguredMcpServers(this.#options)).get(serverId);
			if (!config || config.transport !== "streamable_http") throw new McpOAuthError("mcp_oauth_unsupported");
			if (action === "logout") await new McpOAuthStore(this.#options.homeDir, config).update(async () => undefined, signal);
			else {
				if (!this.#options.onAuthorization || !this.#options.oauthFetch) throw new McpOAuthError("mcp_oauth_unsupported");
				await loginMcpOAuth({ config, homeDir: this.#options.homeDir, signal, fetch: this.#options.oauthFetch(config),
					onAuthorization: (url) => this.#options.onAuthorization!(url, signal) });
			}
			return response(true, action, action === "login" ? `MCP login completed: ${mcpServerSelector(config)}. Open /mcp or start the next turn to refresh discovery.`
				: `MCP credentials removed: ${mcpServerSelector(config)}.`, [], []);
		} catch (error) {
			if (signal.aborted) throw error;
			return response(false, action, action === "login" ? "MCP login did not complete." : "MCP credentials could not be removed.", [],
				[error instanceof McpOAuthError ? error.code : "mcp_oauth_failed"]);
		}
	}

	async add(serverId: string, config: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<McpManagementResponse> {
		return this.#edit("add", serverId, signal, async () => new McpConfigStore(this.#options).add(serverId, config, signal));
	}

	async remove(serverId: string, signal: AbortSignal): Promise<McpManagementResponse> {
		return this.#edit("remove", serverId, signal, async () => new McpConfigStore(this.#options).remove(serverId, signal));
	}

	async approvals(): Promise<McpManagementResponse> {
		try {
			const grants = (await new IntegrationToolApprovalStore(this.#options.homeDir).load()).filter((entry) => entry.id.startsWith("mcp:"));
			return { ...response(true, "approvals", `mcp: ${grants.length} remembered tool approvals`, [], []),
				approvals: Object.freeze(grants.map(({ id }) => ({ id }))) };
		} catch { return response(false, "approvals", "MCP approvals could not be loaded.", [], ["integration_approval_store_failed"]); }
	}

	async revoke(serverId: string): Promise<McpManagementResponse> {
		try {
			const config = (await discoverConfiguredMcpServers(this.#options)).get(serverId);
			await new IntegrationToolApprovalStore(this.#options.homeDir).revokeMcpServer(config?.id ?? serverId);
			return response(true, "revoke", `Remembered MCP approvals removed: ${config ? mcpServerSelector(config) : boundedId(serverId)}`, [], []);
		} catch { return response(false, "revoke", "MCP approvals could not be revoked.", [], ["integration_approval_store_failed"]); }
	}

	async #edit(action: "add" | "remove", serverId: string, signal: AbortSignal, edit: () => Promise<boolean>): Promise<McpManagementResponse> {
		try {
			const changed = await edit();
			const active = (await discoverMcpConfig(this.#options)).get(serverId);
			const project = active?.source === "repository";
			return response(changed, action, changed
				? `MCP user configuration ${action === "add" ? "added" : "removed"}: ${boundedId(serverId)}.${project ? " Repository configuration remains active." : " Changes apply before the next idle turn or catalog inspection."}`
				: `MCP server has no user configuration to remove: ${boundedId(serverId)}.${project ? " The server is configured by this repository." : ""}`,
			[], changed ? [] : ["mcp_server_not_user_managed"]);
		} catch (error) {
			if (signal.aborted) throw error;
			return response(false, action, "MCP configuration was not changed.", [],
				[error instanceof McpConfigError ? error.errorClass : "mcp_config_write_failed"]);
		}
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
		const row = result.rows.find((item) => item.serverId === serverId || item.selector === serverId);
		return response(
			result.ok && row !== undefined && row.status !== "failed",
			"inspect",
			row ? `mcp server: ${row.selector}` : `mcp server not found: ${boundedId(serverId)}`,
			row ? [row] : [],
			result.issues,
		);
	}

	usage(): McpManagementResponse {
		return response(
			true,
			"usage",
			"usage: mycli mcp <list|inspect|add|remove|approvals|revoke|login|logout>",
			[],
			[],
		);
	}

	async #discover(signal: AbortSignal): Promise<{
		readonly ok: boolean;
		readonly rows: readonly McpManagementRow[];
		readonly issues: readonly string[];
	}> {
		const config = await discoverConfiguredMcpServers(this.#options);
		const issues = [...config.diagnostics.map((item) => (
			`${item.source}:${item.fileLabel}:${item.serverId}:${item.errorClass}`
		)), ...config.pluginIssues.map((issue) => `plugin:${issue.pluginId}:${issue.errorClass}`)];
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
		const rows = await Promise.all(discovery.servers.map(async (server) => {
			const settings = config.get(server.serverId)!;
			let authStatus: McpManagementRow["authStatus"];
			try {
				authStatus = settings.transport !== "streamable_http" ? "unsupported"
					: new Headers(settings.headers).has("authorization") ? "configured_header"
						: await new McpOAuthStore(this.#options.homeDir, settings).load() ? "oauth" : "not_logged_in";
			} catch { authStatus = "unavailable"; issues.push(`mcp:${server.serverId}:mcp_oauth_store_failed`); }
			return managementRow(server, settings, authStatus);
		}));
		return Object.freeze({
			ok: issues.length === 0 && rows.every((row) => row.status !== "failed"),
			rows: Object.freeze(rows),
			issues: Object.freeze(issues),
		});
	}
}

function managementRow(server: McpServerDiscovery, config: McpServerConfig, authStatus: McpManagementRow["authStatus"]): McpManagementRow {
	return Object.freeze({
		serverId: server.serverId,
		selector: mcpServerSelector(config),
		authStatus,
		...(config.plugin ? { pluginId: config.plugin.id, pluginServerName: config.plugin.serverName } : {}),
		transport: server.transport,
		enabled: server.enabled,
		status: server.status,
		toolCount: server.toolCount,
		timeoutMs: server.timeoutMs,
		startupTimeoutMs: config.startupTimeoutMs ?? config.timeoutMs,
		toolTimeoutMs: config.toolTimeoutMs ?? config.timeoutMs,
		required: config.required ?? false,
		source: config.source,
		defaultToolsApprovalMode: config.defaultToolsApprovalMode ?? "auto",
		...(config.enabledTools ? { enabledTools: config.enabledTools } : {}),
		...(config.disabledTools ? { disabledTools: config.disabledTools } : {}),
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
