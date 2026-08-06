import type { LoadedPluginManifest } from "@mycli/integrations";
import type { SandboxProfile } from "@mycli/tools";

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
