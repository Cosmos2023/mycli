import { resolveDeniedReadRoots } from "../policy/denied-read-policy.ts";
import {
	hasUnrestrictedNetwork,
	type SandboxProfile,
} from "../policy/execution-policy.ts";
import type { ProcessNetworkProxy, SandboxedProcessLaunch } from "./process-sandbox.ts";

export const WINDOWS_SANDBOX_PROTOCOL_VERSION = 2;

/** The native parser consumes every field, including empty deny lists. */
export interface WindowsSandboxRequest {
	readonly protocol_version: typeof WINDOWS_SANDBOX_PROTOCOL_VERSION;
	readonly command: { readonly argv: readonly string[] };
	readonly cwd: string;
	readonly workspace_roots: readonly string[];
	readonly writable_roots: readonly string[];
	readonly denied_read_roots: readonly string[];
	readonly denied_read_globs: readonly string[];
	readonly filesystem: SandboxProfile["filesystem"];
	readonly network: "enabled" | "disabled";
	readonly network_proxy_port?: number;
	readonly mode: SandboxProfile["mode"];
}

export function windowsRestrictedTokenLaunch(
	executable: string,
	argv: readonly string[],
	profile: SandboxProfile,
	networkProxy?: ProcessNetworkProxy,
): SandboxedProcessLaunch {
	const request: WindowsSandboxRequest = {
		protocol_version: WINDOWS_SANDBOX_PROTOCOL_VERSION,
		command: { argv: [...argv] },
		cwd: profile.cwd,
		workspace_roots: [profile.workspaceRoot],
		writable_roots: [...profile.writableRoots],
		denied_read_roots: resolveDeniedReadRoots(profile.workspaceRoot, profile),
		denied_read_globs: [],
		filesystem: profile.filesystem,
		network: networkProxy || hasUnrestrictedNetwork(profile) ? "enabled" : "disabled",
		...(networkProxy ? { network_proxy_port: networkProxy.port } : {}),
		mode: profile.mode,
	};
	return Object.freeze({
		executable,
		args: Object.freeze(["--request-json", JSON.stringify(request)]),
		isolation: "windows_restricted_token",
	});
}
