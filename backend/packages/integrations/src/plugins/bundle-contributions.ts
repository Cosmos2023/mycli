import { failureScope } from "@mycli/contracts";
import type { SandboxProfile } from "@mycli/tools";
import { parseHookConfigDocument } from "../hooks/config.ts";
import { ConfiguredHookRunner } from "../hooks/runner.ts";
import type { HookConfigDiagnostic } from "../hooks/types.ts";
import type { HookRegistration } from "../hooks/manager.ts";
import type { McpServerConfig } from "../mcp/types.ts";
import type { PluginSkillFile } from "../skills/registry.ts";
import { pluginFailureContext } from "./diagnostics.ts";
import { pluginRouteNamespace } from "./package-files.ts";
import { pluginMcpServers } from "./mcp-servers.ts";
import { PluginHostError } from "./process-host.ts";
import type { PluginDiscovery } from "./types.ts";

export interface PluginBundleContributions {
	readonly skills: readonly PluginSkillFile[];
	readonly mcpServers: readonly McpServerConfig[];
	readonly hooks: readonly HookRegistration[];
	readonly requiredMcpFailures: readonly string[];
	readonly issues: readonly { readonly pluginId: string; readonly errorClass: string }[];
}

export function pluginBundleContributions(discovery: PluginDiscovery, options: {
	readonly workspaceRoot: string;
	readonly env: Readonly<NodeJS.ProcessEnv>;
	readonly sandboxProfile: (cwd: string) => SandboxProfile;
	readonly hookEnabled?: (hook: Pick<HookRegistration, "id" | "hookPoint" | "origin">) => boolean;
}): PluginBundleContributions {
	const skills: PluginSkillFile[] = [];
	const mcp = pluginMcpServers(discovery, options.env);
	const hooks: HookRegistration[] = [];
	const issues: { pluginId: string; errorClass: string }[] = [];
	for (const plugin of discovery.selected) {
		if (plugin.kind !== "bundle" || !plugin.enabled) continue;
		const root = plugin.manifest.pluginRoot;
		const namespace = pluginRouteNamespace(plugin.pluginId);
		skills.push(...plugin.manifest.skillFiles.map((path) => ({ pluginId: plugin.pluginId, path, pluginRoot: root, sourceKind: plugin.source })));
		const runner = new ConfiguredHookRunner({ workspaceRoot: options.workspaceRoot, env: options.env, sandboxProfile: options.sandboxProfile,
			allowlistStore: { statusFor: async () => ({ allowed: true, reason: "matched", commandDigest: "enabled-plugin" }) } });
		for (const [documentIndex, document] of plugin.manifest.hooks.entries()) {
			const diagnostics: HookConfigDiagnostic[] = [];
			const specs = parseHookConfigDocument(document, { path: plugin.manifest.manifestPath, scope: plugin.source },
				{ workspaceRoot: options.workspaceRoot, homeDir: "", env: options.env, pluginRoot: root }, diagnostics);
			issues.push(...diagnostics.map((issue) => ({ pluginId: plugin.pluginId, errorClass: issue.errorClass })));
			for (const spec of specs) {
				const id = `plugin:${namespace}:${documentIndex}-${spec.hookId}`;
				const registration = { id, hookPoint: spec.hookPoint, origin: { pluginId: plugin.pluginId, path: plugin.manifest.manifestPath, command: spec.command, enabled: spec.enabled } };
				const enabled = options.hookEnabled?.(registration) ?? spec.enabled;
				hooks.push({ ...registration, handler: async (input, signal) => {
					const result = await runner.run({ ...spec, enabled, pluginRoot: root }, input, signal);
					return result.action === "error" ? { ...result, errorContext: pluginFailureContext(new PluginHostError("handler_failed"), {
						pluginId: plugin.pluginId, operation: "hooks/run", scope: failureScope("request", `hook:${input.turnId}:${id}`),
					}) } : result;
				} });
			}
		}
	}
	return Object.freeze({ ...mcp, skills, hooks, issues: [...mcp.issues, ...issues] });
}
