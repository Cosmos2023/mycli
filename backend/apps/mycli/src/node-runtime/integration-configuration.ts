import { stat } from "node:fs/promises";
import { join } from "node:path";
import { modelInputSha256 } from "@mycli/core";
import { discoverConfiguredMcpServers, discoverPlugins } from "@mycli/integrations";

export interface RuntimeIntegrationConfiguration {
	readonly plugins: Awaited<ReturnType<typeof discoverPlugins>>;
	readonly mcp: Awaited<ReturnType<typeof discoverConfiguredMcpServers>>;
	readonly fingerprint: string;
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
	const credentials = await stat(join(options.homeDir, ".mycli", "mcp-auth"), { bigint: true }).then(
		(value) => value.mtimeNs.toString(),
		(error: unknown) => {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
			throw error;
		},
	);
	return Object.freeze({ plugins, mcp, fingerprint: modelInputSha256({
		plugins: plugins.selected, diagnostics: plugins.diagnostics,
		servers: mcp.servers, mcpDiagnostics: mcp.diagnostics, credentials,
	}) });
}
