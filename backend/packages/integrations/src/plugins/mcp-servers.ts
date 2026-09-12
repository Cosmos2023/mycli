import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { McpConfigError, parseMcpServerConfig } from "../mcp/config.ts";
import type { McpServerConfig } from "../mcp/types.ts";
import { isObject, PluginPackageError, pluginRouteNamespace } from "./package-files.ts";
import type { PluginDiscovery } from "./types.ts";

export interface PluginMcpContributions {
	readonly mcpServers: readonly McpServerConfig[];
	readonly requiredMcpFailures: readonly string[];
	readonly issues: readonly { readonly pluginId: string; readonly errorClass: string }[];
}

/** Normalize declarations without starting plugin code, hooks or MCP connections. */
export function pluginMcpServers(discovery: PluginDiscovery, env: Readonly<NodeJS.ProcessEnv>): PluginMcpContributions {
	const mcpServers: McpServerConfig[] = [];
	const requiredMcpFailures: string[] = [];
	const issues: { pluginId: string; errorClass: string }[] = [];
	for (const plugin of discovery.selected) {
		if (plugin.kind !== "bundle" || !plugin.enabled) continue;
		const root = plugin.manifest.pluginRoot;
		const seen = new Set<string>();
		for (const document of plugin.manifest.mcp) {
			const servers = document.mcpServers ?? document.mcp_servers ?? document;
			if (!isObject(servers)) { issues.push({ pluginId: plugin.pluginId, errorClass: "plugin_mcp_invalid" }); continue; }
			for (const [name, raw] of Object.entries(servers)) {
				try {
					if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name) || seen.has(name) || !isObject(raw)) throw new PluginPackageError("plugin_mcp_server_invalid");
					seen.add(name);
					const row = expandPluginRoot(raw, root);
					const id = pluginMcpServerId(plugin.pluginId, name);
					const transport = row.transport ?? row.type ?? (row.url ? "streamable_http" : "stdio");
					const config = parseMcpServerConfig(id, { ...row,
						...(row.oauth === undefined ? {} : { oauth: normalizeOAuth(row.oauth) }),
						transport: transport === "http" ? "streamable_http" : transport }, env);
					const cwd = typeof row.cwd === "string" ? isAbsolute(row.cwd) ? row.cwd : resolve(root, row.cwd) : root;
					mcpServers.push(Object.freeze({ ...config, cwd, source: "plugin",
						plugin: Object.freeze({ id: plugin.pluginId, source: plugin.source, serverName: name }),
						pluginDescription: `${plugin.pluginId} ${name}: ${plugin.manifest.description}` }));
				} catch (error) {
					if (isObject(raw) && raw.required === true && raw.enabled !== false) requiredMcpFailures.push(pluginMcpServerId(plugin.pluginId, name));
					issues.push({ pluginId: plugin.pluginId, errorClass: error instanceof McpConfigError ? pluginMcpConfigError(error.errorClass)
						: error instanceof PluginPackageError ? error.code : "plugin_mcp_invalid" });
				}
			}
		}
	}
	return Object.freeze({ mcpServers: Object.freeze(mcpServers), requiredMcpFailures: Object.freeze(requiredMcpFailures), issues: Object.freeze(issues) });
}

export function pluginMcpServerId(pluginId: string, serverName: string): string {
	return `plugin-${pluginRouteNamespace(pluginId).slice(0, 20)}-${createHash("sha256").update(`${pluginId}:${serverName}`).digest("hex").slice(0, 16)}`;
}

function normalizeOAuth(value: unknown): unknown {
	if (!isObject(value)) return value;
	const { clientId, callbackPort, ...rest } = value;
	return { ...rest, ...(clientId === undefined || rest.client_id !== undefined ? {} : { client_id: clientId }),
		...(callbackPort === undefined || rest.callback_port !== undefined ? {} : { callback_port: callbackPort }) };
}

function expandPluginRoot(value: Readonly<Record<string, unknown>>, root: string): Readonly<Record<string, unknown>> {
	const expand = (item: unknown): unknown => typeof item === "string"
		? item.replaceAll("${CLAUDE_PLUGIN_ROOT}", root).replaceAll("${CODEX_PLUGIN_ROOT}", root)
		: Array.isArray(item) ? item.map(expand) : isObject(item) ? Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, expand(nested)])) : item;
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
}

function pluginMcpConfigError(code: string): string {
	switch (code) {
		case "invalid_env": return "plugin_mcp_env_invalid";
		case "invalid_headers": return "plugin_mcp_headers_invalid";
		case "invalid_cwd": return "plugin_mcp_cwd_invalid";
		default: return code;
	}
}
