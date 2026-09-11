import { basename, dirname } from "node:path";
import type { McpManagerDiscovery, McpServerConfig, PluginRuntime } from "@mycli/integrations";

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
		const status = !config.enabled ? "disabled" : server?.status === "failed" ? "failed"
			: server?.status === "ok" ? phase === "cached" || failure ? "cached" : "ready"
				: phase === "failed" ? "failed" : "loading";
		const tools = discovery?.registrations.filter((item) => item.originMetadata.server === config.id)
			.map((item) => item.definition.name) ?? [];
		const resources = discovery?.resources.filter((item) => item.serverId === config.id)
			.map((item) => item.name) ?? [];
		const toolCount = server?.toolCount ?? tools.length;
		const resourceCount = server?.resourceCount ?? resources.length;
		return Object.freeze({
			id: `mcp:${config.id}`, type: "mcp", name: config.id, source: "runtime",
			enabled: config.enabled, status,
			detail: `${toolCount} tools, ${resourceCount} resources${failure ? `; ${failure}` : ""}`,
			tool_names: Object.freeze(tools), tool_count: toolCount, resource_count: resourceCount,
			inspection_detail: [
				...(config.pluginDescription ? [config.pluginDescription] : []),
				`Transport: ${config.transport}`, `Timeout: ${config.timeoutMs} ms`,
				`Resources (${resourceCount}): ${catalogNames(resources, resourceCount)}`,
				...(failure ? [`Connection issue: ${failure}`] : []),
			].join("\n"),
			command: "/mcp",
		});
	}));
}

export function pluginCatalogResources(runtime: Pick<PluginRuntime, "records" | "discovery" | "commands">): readonly CatalogResource[] {
	return Object.freeze(runtime.records.map((record): CatalogResource => {
		const candidate = runtime.discovery.get(record.pluginId);
		const manifest = candidate?.kind === "plugin" || candidate?.kind === "bundle" ? candidate.manifest : undefined;
		const bundle = candidate?.kind === "bundle" ? candidate.manifest : undefined;
		const provides = candidate?.kind === "plugin" ? candidate.manifest.provides : undefined;
		const tools = provides?.tools ?? record.tools;
		const skills = bundle?.skillFiles.map((path) => basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path)) ?? [];
		const mcp = bundle?.mcp.flatMap((document) => objectKeys(document.mcpServers ?? document.mcp_servers ?? document)) ?? [];
		const hooks = provides?.hooks ?? bundle?.hooks.flatMap(declaredHookNames) ?? record.hooks;
		const commands = runtime.commands.list(record.pluginId).map((command) => `/plugin:${record.pluginId}:${command.name}`);
		const declaredCommands = provides?.commands ?? record.commands;
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
				`Hooks (${hooks.length}): ${catalogNames(hooks)}`,
				`Tools (${tools.length}): ${catalogNames(tools)}`,
				`Commands (${declaredCommands.length}): ${catalogNames(commands.length ? commands : declaredCommands)}`,
				...(record.issues.length ? [`Issues: ${catalogNames(record.issues)}`] : []),
			].join("\n"),
			command: "/plugins",
		});
	}));
}

function objectKeys(value: unknown): readonly string[] {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.keys(value) : [];
}

function declaredHookNames(document: Readonly<Record<string, unknown>>): readonly string[] {
	const hooks = document.hooks ?? document;
	if (!Array.isArray(hooks)) return objectKeys(hooks);
	return hooks.flatMap((hook: unknown) => typeof hook === "object" && hook !== null
		&& "hook_point" in hook && typeof hook.hook_point === "string" ? [hook.hook_point] : []);
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
