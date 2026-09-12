import type { McpManagerDiscovery, McpServerConfig, PluginRuntime } from "@mycli/integrations";
import { mcpServerSelector, pluginDeclarations } from "@mycli/integrations";

type CatalogResource = {
	readonly id: string;
	readonly type: "mcp" | "plugin";
	readonly name: string;
	readonly source: string;
	readonly enabled: boolean;
	readonly status: string;
	readonly detail?: string;
	readonly inspection_detail: string;
	readonly command: string;
	readonly tool_names?: readonly string[];
	readonly tool_count?: number;
	readonly resource_count?: number;
};

export type McpCatalogPhase = "loading" | "cached" | "ready" | "failed";

export function mcpCatalogResources(
	configs: readonly McpServerConfig[],
	discovery: McpManagerDiscovery | undefined,
	phase: McpCatalogPhase,
): readonly CatalogResource[] {
	return Object.freeze(configs.map((config): CatalogResource => {
		const server = discovery?.servers.find((item) => item.serverId === config.id);
		const failure = server?.failureCategory ?? (phase === "failed" ? "refresh_failed" : undefined);
		const status = !config.enabled ? "disabled" : server?.status === "partial" ? "partial" : server?.status === "failed" ? "failed"
			: server?.status === "ok" ? phase === "cached" || failure ? "cached" : "ready"
				: phase === "failed" ? "failed" : "loading";
		const tools = discovery?.registrations.filter((item) => item.originMetadata.server === config.id)
			.map((item) => item.definition.name) ?? [];
		const resources = discovery?.resources.filter((item) => item.serverId === config.id)
			.map((item) => item.name) ?? [];
		const toolCount = server?.toolCount ?? tools.length;
		const resourceCount = server?.resourceCount ?? resources.length;
		return Object.freeze({
			id: `mcp:${config.id}`, type: "mcp", name: mcpServerSelector(config), source: "runtime",
			enabled: config.enabled, status,
			detail: `${toolCount} tools, ${resourceCount} resources${failure ? `; ${failure}` : ""}`,
			tool_names: Object.freeze(tools), tool_count: toolCount, resource_count: resourceCount,
			inspection_detail: [
				...(config.pluginDescription ? [config.pluginDescription] : []),
				...(config.plugin ? [`Plugin: ${config.plugin.id} (${config.plugin.source}); declared server: ${config.plugin.serverName}`] : []),
				...(config.plugin ? [`Server id: ${config.id}`] : []),
				`Manage: mycli mcp inspect ${mcpServerSelector(config)}`,
				...(config.transport === "streamable_http" ? [`Login: mycli mcp login ${mcpServerSelector(config)}`] : []),
				`Transport: ${config.transport}`,
				`Startup timeout: ${config.startupTimeoutMs ?? config.timeoutMs} ms; tool timeout: ${config.toolTimeoutMs ?? config.timeoutMs} ms`,
				`Source: ${config.source ?? "user"}; required: ${config.required ?? false}; approval: ${config.defaultToolsApprovalMode ?? "auto"}`,
				...(config.enabledTools ? [`Enabled tools: ${catalogNames(config.enabledTools, config.enabledTools.length)}`] : []),
				...(config.disabledTools?.length ? [`Disabled tools: ${catalogNames(config.disabledTools, config.disabledTools.length)}`] : []),
				`Resources (${resourceCount}): ${catalogNames(resources, resourceCount)}`,
				...(server?.failures?.length
					? server.failures.slice(0, 20).map((issue) => `${issue.capability}${issue.tool ? `/${issue.tool}` : ""}: ${issue.category}`)
					: failure ? [`Connection issue: ${failure}`] : []),
				...((server?.failureCount ?? 0) > (server?.failures?.length ?? 0)
					? [`${server!.failureCount! - (server!.failures?.length ?? 0)} more issues`] : []),
			].join("\n"),
			command: "/mcp",
		});
	}));
}

export function pluginCatalogResources(runtime: Pick<PluginRuntime, "records" | "discovery" | "commands">, servers: readonly McpServerConfig[] = []): readonly CatalogResource[] {
	return Object.freeze(runtime.records.map((record): CatalogResource => {
		const candidate = runtime.discovery.get(record.pluginId);
		const manifest = candidate?.kind === "plugin" || candidate?.kind === "bundle" ? candidate.manifest : undefined;
		const bundle = candidate?.kind === "bundle" ? candidate.manifest : undefined;
		const declared = pluginDeclarations(candidate);
		const tools = manifest ? declared.tools : record.tools;
		const skills = declared.skills;
		const mcp = declared.mcpServers;
		const hooks = manifest ? declared.hooks : record.hooks;
		const commands = runtime.commands.list(record.pluginId).map((command) => `/plugin:${record.pluginId}:${command.name}`);
		const declaredCommands = manifest ? declared.commands : record.commands;
		return Object.freeze({
			id: `plugin:${record.pluginId}`, type: "plugin", name: record.pluginId,
			source: record.source, enabled: record.enabled,
			status: record.status === "loaded" ? "enabled" : record.status,
			...(record.issues[0] ? { detail: record.issues[0].slice(0, 512) } : {}),
			inspection_detail: [
				...(manifest?.description ? [manifest.description.slice(0, 320)] : []),
				`Format: ${bundle ? "Codex bundle" : candidate?.kind === "plugin" ? "Plugin API v2" : "unavailable"}`,
				...(manifest?.version ? [`Version: ${manifest.version}`] : []),
				`Skills (${skills.length}): ${catalogNames(skills)}`,
				`MCP servers (${mcp.length}): ${catalogNames(mcp)}`,
				...servers.filter((server) => server.plugin?.id === record.pluginId).slice(0, 20)
					.map((server) => `MCP: ${mcpServerSelector(server)} → ${server.id}`),
				`Hooks (${hooks.length}): ${catalogNames(hooks)}`,
				`Tools (${tools.length}): ${catalogNames(tools)}`,
				`Commands (${declaredCommands.length}): ${catalogNames(commands.length ? commands : declaredCommands)}`,
				...(record.issues.length ? [`Issues: ${catalogNames(record.issues)}`] : []),
			].join("\n"),
			command: "/plugins",
		});
	}));
}

export function catalogNames(names: readonly string[], total = names.length): string {
	const visible: string[] = [];
	let length = 0;
	for (const name of names) {
		if (visible.length >= 20 || length + name.length > 220) break;
		visible.push(name);
		length += name.length + 2;
	}
	const remaining = Math.max(0, total - visible.length);
	return [...visible, ...(remaining ? [`(${remaining} more)`] : [])].join(", ") || "none";
}
