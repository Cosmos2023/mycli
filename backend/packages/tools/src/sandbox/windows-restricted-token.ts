import {
	hasUnrestrictedNetwork,
	type SandboxProfile,
} from "../policy/execution-policy.ts";
import type { SandboxedProcessLaunch } from "./process-sandbox.ts";

export const WINDOWS_SANDBOX_PROTOCOL_VERSION = 1;

export function windowsRestrictedTokenLaunch(
	executable: string,
	argv: readonly string[],
	profile: SandboxProfile,
): SandboxedProcessLaunch {
	const request = {
		protocol_version: WINDOWS_SANDBOX_PROTOCOL_VERSION,
		command: { argv: [...argv] },
		cwd: profile.cwd,
		workspace_roots: [profile.workspaceRoot],
		writable_roots: [...profile.writableRoots],
		filesystem: profile.filesystem,
		network: hasUnrestrictedNetwork(profile) ? "enabled" : "disabled",
		mode: profile.mode,
	};
	return Object.freeze({
		executable,
		args: Object.freeze(["--request-json", JSON.stringify(request)]),
		isolation: "windows_restricted_token",
	});
}
