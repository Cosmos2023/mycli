import { realpathSync } from "node:fs";

export type PermissionProfile = "read-only" | "workspace" | "full-access";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type FilesystemPolicy = "read_only" | "workspace_write" | "unrestricted";
export type NetworkPolicy = "disabled" | "enabled";

export interface ExecutionPolicy {
	readonly mode: SandboxMode;
	readonly filesystem: FilesystemPolicy;
	readonly network: NetworkPolicy;
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
	const workspace = realpathSync(workspaceRoot);
	switch (permission) {
		case "read-only":
			return immutablePolicy("read-only", "read_only", "disabled", []);
		case "workspace":
			return immutablePolicy("workspace-write", "workspace_write", "disabled", [workspace]);
		case "full-access":
			return immutablePolicy("danger-full-access", "unrestricted", "enabled", [workspace]);
	}
}

export function hasUnrestrictedFilesystem(
	policy: ExecutionPolicy | undefined,
): boolean {
	return policy?.filesystem === "unrestricted";
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
