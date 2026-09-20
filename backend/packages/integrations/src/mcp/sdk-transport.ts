import { resolveDeniedReadRoots } from "@mycli/tools";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { prepareSandboxedProcess, ProcessSandboxError, startNetworkProxy, type NetworkProxyLease, type SandboxProfile } from "@mycli/tools";
import { LegacyHttpTransport } from "./legacy-http-transport.ts";
import { diagnosticMcpFetch, policyMcpFetch } from "./http-fetch.ts";
import { authenticatedMcpFetch } from "./oauth-fetch.ts";
import type { McpServerConfig } from "./types.ts";

export interface McpTransportOptions {
	readonly config: McpServerConfig;
	readonly sandboxProfile?: SandboxProfile;
	readonly cwd?: string;
	readonly homeDir?: string;
	readonly fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

export interface McpTransportLease {
	readonly transport: Transport;
	close(): Promise<void>;
}

/** Each protocol generation owns both its process/HTTP transport and any network proxy. */
export async function createMcpTransport(options: McpTransportOptions, signal: AbortSignal): Promise<McpTransportLease> {
	signal.throwIfAborted();
	const { config } = options;
	let proxy: NetworkProxyLease | undefined;
	try {
		let transport: Transport;
		if (config.transport === "stdio") {
			if (!config.command) throw new Error("mcp_stdio_command_required");
			if (!options.sandboxProfile) throw new Error("mcp_sandbox_required");
			const cwd = config.cwd ?? options.cwd ?? options.sandboxProfile.cwd;
			const profile: SandboxProfile = { ...options.sandboxProfile, cwd,
				...(options.sandboxProfile.deniedReadGlobs?.length ? {
					deniedReadRoots: resolveDeniedReadRoots(options.sandboxProfile.workspaceRoot, options.sandboxProfile),
					deniedReadGlobs: [],
				} : {}),
				// The launch directory may be a plugin installation; writable roots remain independently bounded.
				workspaceRoot: cwd,
				...(config.sandbox?.mode === "workspace-write" && options.sandboxProfile.filesystem === "unrestricted"
					? { mode: "workspace-write", filesystem: "workspace_write", writableRoots: [options.sandboxProfile.workspaceRoot] } : {}),
				...(config.sandbox?.mode === "read-only" ? { mode: "read-only", filesystem: "read_only", writableRoots: [] } : {}),
				network: config.sandbox?.network === "disabled" ? "disabled" : options.sandboxProfile.network };
			let launchProfile = profile;
			// Only the Windows PSEC backend supports custom process read roots.
			if (profile.readableRoots !== undefined && process.platform !== "win32") throw new ProcessSandboxError("sandbox_unavailable", "MCP process read restrictions cannot be enforced on this platform.");
			if (profile.network === "enabled" && profile.networkDomains !== undefined) {
				if (profile.networkDomains.length === 0) launchProfile = { ...profile, network: "disabled" };
				else {
					if (process.platform !== "darwin" && process.platform !== "win32") throw new ProcessSandboxError("network_proxy_unavailable");
					proxy = await startNetworkProxy({ domains: profile.networkDomains });
				}
			}
			signal.throwIfAborted();
			const launch = prepareSandboxedProcess([config.command, ...config.args], launchProfile, {}, proxy);
			const stdio = new StdioClientTransport({ command: launch.executable, args: [...launch.args],
				env: Object.fromEntries(Object.entries({ ...config.env, ...proxy?.env, ...launch.env }).flatMap(([key, value]) => value === undefined ? [] : [[key, value]])), stderr: "pipe", cwd, maxBufferSize: 1_048_576 });
			stdio.stderr?.on("data", () => undefined);
			transport = stdio;
		} else {
			if (!config.url) throw new Error("mcp_remote_url_required");
			const url = new URL(config.url);
			const fetch = policyMcpFetch({ network: config.sandbox?.network === "disabled" ? "disabled" : options.sandboxProfile?.network ?? "enabled",
				networkDomains: options.sandboxProfile?.networkDomains }, options.fetch);
			const request = diagnosticMcpFetch(fetch);
			const authenticated = options.homeDir && !new Headers(config.headers).has("authorization")
				? authenticatedMcpFetch({ config, homeDir: options.homeDir, request, authFetch: fetch }) : request;
			transport = config.transport === "streamable_http"
				? new StreamableHTTPClientTransport(url, { requestInit: { headers: { ...config.headers } }, fetch: authenticated })
				: new LegacyHttpTransport({ url, headers: config.headers, fetch });
		}
		let closing: Promise<void> | undefined;
		let proxyClosing: Promise<void> | undefined;
		const closeProxy = (): Promise<void> => proxyClosing ??= proxy?.close() ?? Promise.resolve();
		const closeTransport = transport.close.bind(transport);
		transport.onclose = () => { void closeProxy().catch(() => undefined); };
		transport.close = () => closing ??= (async () => {
			try { await closeTransport(); } finally { await closeProxy(); }
		})();
		return { transport, close: () => transport.close() };
	} catch (error) {
		await proxy?.close();
		throw error;
	}
}
