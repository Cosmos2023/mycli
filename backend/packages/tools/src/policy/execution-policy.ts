import { realpathSync } from "node:fs";
export {
	networkDomainAllowed,
	normalizeNetworkDomains,
} from "@mycli/core";

export type PermissionProfile = "read-only" | "workspace" | "full-access";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type FilesystemPolicy = "read_only" | "workspace_write" | "unrestricted";
export type NetworkPolicy = "disabled" | "enabled";

export interface ExecutionPolicy {
	readonly deniedReadRoots?: readonly string[];
	readonly deniedReadGlobs?: readonly string[];
	readonly mode: SandboxMode;
	readonly filesystem: FilesystemPolicy;
	readonly network: NetworkPolicy;
	readonly networkDomains?: readonly string[];
	readonly readableRoots?: readonly string[];
	readonly writableRoots: readonly string[];
}

export interface SandboxProfile extends ExecutionPolicy {
	readonly workspaceRoot: string;
	readonly cwd: string;
}

export function executionPolicy(
	permission: PermissionProfile,
	workspaceRoot: string,
): ExecutionPolicy {
	if (!workspaceRoot.trim()) throw new TypeError("workspaceRoot must be non-empty");
	const workspace = realpathSync.native(workspaceRoot);
	switch (permission) {
		case "read-only":
			return immutablePolicy("read-only", "read_only", "disabled", []);
		case "workspace":
			return immutablePolicy("workspace-write", "workspace_write", "enabled", [workspace]);
		case "full-access":
			return immutablePolicy("danger-full-access", "unrestricted", "enabled", [workspace]);
	}
}

export function hasUnrestrictedFilesystem(
	policy: ExecutionPolicy | undefined,
): boolean {
	return policy?.filesystem === "unrestricted";
}

export function hasUnrestrictedNetwork(
	policy: ExecutionPolicy | undefined,
): boolean {
	return policy?.network === "enabled" && policy.networkDomains === undefined;
}

function immutablePolicy(
	mode: SandboxMode,
	filesystem: FilesystemPolicy,
	network: NetworkPolicy,
	writableRoots: readonly string[],
): ExecutionPolicy {
	return Object.freeze({
		mode,
		filesystem,
		network,
		writableRoots: Object.freeze([...writableRoots]),
	});
}
