import { discoverPlugins } from "../plugins/discovery.ts";
import { pluginMcpServers, type PluginMcpContributions } from "../plugins/mcp-servers.ts";
import type { PluginDiscovery } from "../plugins/types.ts";
import { discoverMcpConfig, type DiscoverMcpConfigOptions } from "./config.ts";
import type { McpConfigDiscovery, McpServerConfig } from "./types.ts";

export interface ConfiguredMcpServers extends McpConfigDiscovery {
	readonly pluginIssues: PluginMcpContributions["issues"];
	readonly requiredPluginFailures: readonly string[];
}

/** The same effective configured servers serve CLI auth/inspection and runtime assembly. */
export async function discoverConfiguredMcpServers(
	options: DiscoverMcpConfigOptions,
	discovery?: PluginDiscovery,
): Promise<ConfiguredMcpServers> {
	const direct = await discoverMcpConfig(options);
	const pluginDiscovery = discovery ?? await discoverPlugins(options);
	const plugins = pluginMcpServers(pluginDiscovery, options.env);
	const byId = new Map(plugins.mcpServers.map((server) => [server.id, server]));
	// An explicit server configuration owns its exact id, including deliberate overrides.
	for (const server of direct.servers) byId.set(server.id, server);
	const servers = Object.freeze([...byId.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
	const aliases = new Map(servers.filter((server) => server.plugin).map((server) => [mcpServerSelector(server), server]));
	return Object.freeze({ servers, diagnostics: direct.diagnostics,
		pluginIssues: Object.freeze([...pluginDiscovery.diagnostics, ...plugins.issues]),
		requiredPluginFailures: Object.freeze(plugins.requiredMcpFailures.filter((id) => !direct.get(id))),
		get: (id: string) => byId.get(id) ?? aliases.get(id) });
}

export function mcpServerSelector(server: McpServerConfig): string {
	return server.plugin ? `${server.plugin.id}/${server.plugin.serverName}` : server.id;
}
