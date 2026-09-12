import type { LoadedPluginManifest, McpServerConfig } from "@mycli/integrations";
import type { SandboxProfile } from "@mycli/tools";
import { ExecutionPolicyCoordinator, type ExecutionPolicyConstraints } from "@mycli/runtime";

export function mcpSandboxProfile(workspaceRoot: string, config: McpServerConfig, constraints?: ExecutionPolicyConstraints): SandboxProfile {
	const coordinator = new ExecutionPolicyCoordinator({ workspaceRoot, ...(constraints ? { constraints } : {}) });
	coordinator.configure({ trust: "trusted", permission: "workspace" });
	const base = coordinator.snapshot().profile;
	const readonly = config.sandbox?.mode === "read-only";
	return Object.freeze({ ...base,
		...(readonly ? { mode: "read-only" as const, filesystem: "read_only" as const, writableRoots: Object.freeze([]) } : {}),
		network: config.sandbox?.network === "disabled" ? "disabled" : base.network,
		workspaceRoot, cwd: config.cwd ?? workspaceRoot });
}

export function workspaceSandboxProfile(
	workspaceRoot: string,
	cwd = workspaceRoot,
): SandboxProfile {
	return Object.freeze({
		mode: "workspace-write",
		filesystem: "workspace_write",
		network: "disabled",
		writableRoots: Object.freeze([workspaceRoot]),
		workspaceRoot,
		cwd,
	});
}

export function pluginSandboxProfile(manifest: LoadedPluginManifest): SandboxProfile {
	const capabilities = new Set<string>(manifest.capabilities as readonly string[]);
	const writable = capabilities.has("filesystem_write");
	return Object.freeze({
		mode: writable ? "workspace-write" : "read-only",
		filesystem: writable ? "workspace_write" : "read_only",
		network: capabilities.has("network") ? "enabled" : "disabled",
		writableRoots: Object.freeze(writable ? [manifest.pluginRoot] : []),
		workspaceRoot: manifest.pluginRoot,
		cwd: manifest.pluginRoot,
	});
}
