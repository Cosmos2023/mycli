import { stat } from "node:fs/promises";
import { join } from "node:path";
import { modelInputSha256 } from "@mycli/core";
import { discoverConfiguredMcpServers, discoverPlugins, discoverHookConfig, HookAllowlistStore, SkillRegistry, builtinSkillRoot, IntegrationEnablementStore, type IntegrationEnablementSnapshot } from "@mycli/integrations";

export interface RuntimeIntegrationConfiguration {
	readonly skills: SkillRegistry;
	readonly hooks: Awaited<ReturnType<typeof discoverHookConfig>>;
	readonly hookApprovals: readonly Awaited<ReturnType<HookAllowlistStore["statusFor"]>>[];
	readonly plugins: Awaited<ReturnType<typeof discoverPlugins>>;
	readonly mcp: Awaited<ReturnType<typeof discoverConfiguredMcpServers>>;
	readonly fingerprint: string;
	readonly enablement: IntegrationEnablementSnapshot;
}

/** Read configuration only; unchanged turns keep their existing clients and catalogs. */
export async function loadRuntimeIntegrationConfiguration(options: {
	readonly workspaceRoot: string;
	readonly homeDir: string;
	readonly env: Readonly<NodeJS.ProcessEnv>;
	readonly includeRepository: boolean;
}): Promise<RuntimeIntegrationConfiguration> {
	const plugins = await discoverPlugins(options);
	const mcp = await discoverConfiguredMcpServers(options, plugins);
	const enablement = await new IntegrationEnablementStore(options).load();
	const skills = await SkillRegistry.discover({
		enablement, builtinRoot: builtinSkillRoot(), userRoot: join(options.homeDir, ".mycli", "skills"),
		...(options.includeRepository ? { sharedRepoRoot: join(options.workspaceRoot, ".agents", "skills"), repoRoot: join(options.workspaceRoot, ".mycli", "skills") } : {}),
		pluginSkills: plugins.selected.flatMap((plugin) => plugin.kind === "bundle" && plugin.enabled ? plugin.manifest.skillFiles.map((path) => ({ pluginId: plugin.pluginId, path, pluginRoot: plugin.manifest.pluginRoot, sourceKind: plugin.source })) : []),
	});
	const hooks = await discoverHookConfig(options);
	const allowlist = new HookAllowlistStore(options);
	const hookApprovals = await Promise.all(hooks.hooks.map((hook) => allowlist.statusFor(hook)));
	const credentials = await stat(join(options.homeDir, ".mycli", "mcp-auth"), { bigint: true }).then(
		(value) => value.mtimeNs.toString(),
		(error: unknown) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
			throw error;
		},
	);
	return Object.freeze({ plugins, mcp, enablement, skills, hooks, hookApprovals, fingerprint: modelInputSha256({
		skills: skills.listAll(), skillDiagnostics: skills.diagnostics(), hooks, hookApprovals,
		plugins: plugins.selected, diagnostics: plugins.diagnostics,
		servers: mcp.servers, mcpDiagnostics: mcp.diagnostics, credentials, enablement,
	}) });
}
