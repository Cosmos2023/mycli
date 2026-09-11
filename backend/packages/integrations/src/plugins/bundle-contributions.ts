import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { failureScope } from "@mycli/contracts";
import type { SandboxProfile } from "@mycli/tools";
import { parseHookConfigDocument } from "../hooks/config.ts";
import { ConfiguredHookRunner } from "../hooks/runner.ts";
import type { HookConfigDiagnostic } from "../hooks/types.ts";
import type { HookRegistration } from "../hooks/manager.ts";
import { McpConfigError, parseMcpServerConfig } from "../mcp/config.ts";
import type { McpServerConfig } from "../mcp/types.ts";
import type { PluginSkillFile } from "../skills/registry.ts";
import { pluginFailureContext } from "./diagnostics.ts";
import { isObject, PluginPackageError, pluginRouteNamespace } from "./package-files.ts";
import { PluginHostError } from "./process-host.ts";
import type { PluginDiscovery } from "./types.ts";

export interface PluginBundleContributions {
	readonly skills: readonly PluginSkillFile[];
	readonly mcpServers: readonly McpServerConfig[];
	readonly hooks: readonly HookRegistration[];
	readonly issues: readonly { readonly pluginId: string; readonly errorClass: string }[];
}

export function pluginBundleContributions(discovery: PluginDiscovery, options: {
	readonly workspaceRoot: string;
	readonly env: Readonly<NodeJS.ProcessEnv>;
	readonly sandboxProfile: (cwd: string) => SandboxProfile;
}): PluginBundleContributions {
	const skills: PluginSkillFile[] = [];
	const mcpServers: McpServerConfig[] = [];
	const hooks: HookRegistration[] = [];
	const issues: { pluginId: string; errorClass: string }[] = [];
	for (const plugin of discovery.selected) {
		if (plugin.kind !== "bundle" || !plugin.enabled) continue;
		const root = plugin.manifest.pluginRoot;
		const namespace = pluginRouteNamespace(plugin.pluginId);
		skills.push(...plugin.manifest.skillFiles.map((path) => ({ pluginId: plugin.pluginId, path, pluginRoot: root, sourceKind: plugin.source })));
		const seen = new Set<string>();
		for (const document of plugin.manifest.mcp) {
			const servers = document.mcpServers ?? document.mcp_servers ?? document;
			if (!isObject(servers)) { issues.push({ pluginId: plugin.pluginId, errorClass: "plugin_mcp_invalid" }); continue; }
			for (const [name, raw] of Object.entries(servers)) {
				try {
					if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name) || seen.has(name) || !isObject(raw)) throw new PluginPackageError("plugin_mcp_server_invalid");
					seen.add(name);
					const row = expandPluginRoot(raw, root);
					const env = stringTable(row.env, "plugin_mcp_env_invalid");
					if (row.env_vars !== undefined) {
						if (!Array.isArray(row.env_vars)) throw new PluginPackageError("plugin_mcp_env_invalid");
						for (const key of row.env_vars) {
							if (typeof key !== "string" || options.env[key] === undefined) throw new PluginPackageError("missing_environment");
							env[key] = options.env[key];
						}
					}
					const headers = { ...stringTable(row.http_headers, "plugin_mcp_headers_invalid"), ...stringTable(row.headers, "plugin_mcp_headers_invalid") };
					if (row.bearer_token_env_var !== undefined) {
						if (typeof row.bearer_token_env_var !== "string") throw new PluginPackageError("plugin_mcp_env_invalid");
						const token = options.env[row.bearer_token_env_var];
						if (!token) throw new PluginPackageError("missing_environment");
						Object.assign(headers, { Authorization: `Bearer ${token}` });
					}
					const id = `plugin-${namespace.slice(0, 20)}-${createHash("sha256").update(`${plugin.pluginId}:${name}`).digest("hex").slice(0, 16)}`;
					const transport = row.transport ?? row.type ?? (row.url ? "streamable_http" : "stdio");
					const config = parseMcpServerConfig(id, { ...row, transport: transport === "http" ? "streamable_http" : transport,
						env, headers, timeout_seconds: row.tool_timeout_sec ?? row.timeout_seconds }, options.env);
					if (row.cwd !== undefined && (typeof row.cwd !== "string" || !row.cwd.trim())) throw new PluginPackageError("plugin_mcp_cwd_invalid");
					const cwd = typeof row.cwd === "string" ? isAbsolute(row.cwd) ? row.cwd : resolve(root, row.cwd) : root;
					mcpServers.push(Object.freeze({ ...config, cwd, pluginDescription: `${plugin.pluginId} ${name}: ${plugin.manifest.description}` }));
				} catch (error) { issues.push({ pluginId: plugin.pluginId, errorClass: error instanceof McpConfigError ? error.errorClass : error instanceof PluginPackageError ? error.code : "plugin_mcp_invalid" }); }
			}
		}
		const runner = new ConfiguredHookRunner({ workspaceRoot: options.workspaceRoot, env: options.env, sandboxProfile: options.sandboxProfile,
			allowlistStore: { statusFor: async () => ({ allowed: true, reason: "matched", commandDigest: "enabled-plugin" }) } });
		for (const [documentIndex, document] of plugin.manifest.hooks.entries()) {
			const diagnostics: HookConfigDiagnostic[] = [];
			const specs = parseHookConfigDocument(document, { path: plugin.manifest.manifestPath, scope: plugin.source },
				{ workspaceRoot: options.workspaceRoot, homeDir: "", env: options.env }, diagnostics);
			issues.push(...diagnostics.map((issue) => ({ pluginId: plugin.pluginId, errorClass: issue.errorClass })));
			for (const spec of specs) {
				const id = `plugin:${namespace}:${documentIndex}-${spec.hookId}`;
				hooks.push({ id, hookPoint: spec.hookPoint, handler: async (input, signal) => {
					const result = await runner.run({ ...spec, pluginRoot: root }, input, signal);
					return result.action === "error" ? { ...result, errorContext: pluginFailureContext(new PluginHostError("handler_failed"), {
						pluginId: plugin.pluginId, operation: "hooks/run", scope: failureScope("request", `hook:${input.turnId}:${id}`),
					}) } : result;
				} });
			}
		}
	}
	return Object.freeze({ skills, mcpServers, hooks, issues });
}

function stringTable(value: unknown, code: string): Record<string, string> {
	if (value === undefined) return {};
	if (!isObject(value)) throw new PluginPackageError(code);
	const entries = Object.entries(value);
	if (entries.some(([, item]) => typeof item !== "string")) throw new PluginPackageError(code);
	return Object.fromEntries(entries) as Record<string, string>;
}

function expandPluginRoot(value: Readonly<Record<string, unknown>>, root: string): Readonly<Record<string, unknown>> {
	const expand = (item: unknown): unknown => typeof item === "string"
		? item.replaceAll("${CLAUDE_PLUGIN_ROOT}", root).replaceAll("${CODEX_PLUGIN_ROOT}", root)
		: Array.isArray(item) ? item.map(expand) : isObject(item) ? Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, expand(nested)])) : item;
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
}
