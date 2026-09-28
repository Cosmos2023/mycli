import type { LoadedPluginManifest, McpServerConfig } from "@mycli/integrations";
import { resolveDeniedReadRoots, type SandboxProfile } from "@mycli/tools";
import { ExecutionPolicyCoordinator, type ExecutionPolicyConstraints } from "@mycli/runtime";

export function mcpSandboxProfile(workspaceRoot: string, config: McpServerConfig, constraints?: ExecutionPolicyConstraints): SandboxProfile {
	const coordinator = new ExecutionPolicyCoordinator({ workspaceRoot, ...(constraints ? { constraints } : {}) });
	// MCP servers own long-lived processes independently of the Shell permission preset.
	// Explicit server restrictions and managed bounds still select an enforced sandbox.
	coordinator.configure({ trust: "trusted", permission: config.sandbox?.mode ? "workspace" : "full-access" });
	const base = coordinator.snapshot().profile;
	const readonly = config.sandbox?.mode === "read-only";
	return offlineProcessProfile(Object.freeze({ ...base,
		...(readonly ? { mode: "read-only" as const, filesystem: "read_only" as const, writableRoots: Object.freeze([]) } : {}),
		network: config.sandbox?.network === "disabled" ? "disabled" : base.network,
		workspaceRoot, cwd: config.cwd ?? workspaceRoot }));
}

export function workspaceSandboxProfile(
	workspaceRoot: string,
	cwd = workspaceRoot,
	constraints?: ExecutionPolicyConstraints,
): SandboxProfile {
	return constrainProcessProfile(Object.freeze({
		mode: "workspace-write",
		filesystem: "workspace_write",
		network: "disabled",
		writableRoots: Object.freeze([workspaceRoot]),
		workspaceRoot,
		cwd,
	}), constraints);
}

export function pluginSandboxProfile(manifest: LoadedPluginManifest, constraints?: ExecutionPolicyConstraints, workspaceRoot = manifest.pluginRoot): SandboxProfile {
	const capabilities = new Set<string>(manifest.capabilities as readonly string[]);
	const writable = capabilities.has("filesystem_write");
	return constrainProcessProfile(Object.freeze({
		mode: writable ? "workspace-write" : "read-only",
		filesystem: writable ? "workspace_write" : "read_only",
		network: capabilities.has("network") ? "enabled" : "disabled",
		writableRoots: Object.freeze(writable ? [manifest.pluginRoot] : []),
		workspaceRoot: manifest.pluginRoot,
		cwd: manifest.pluginRoot,
	}), constraints, workspaceRoot);
}

function constrainProcessProfile(profile: SandboxProfile, constraints: ExecutionPolicyConstraints | undefined,
	workspaceRoot = profile.workspaceRoot): SandboxProfile {
	if (!constraints) return profile;
	const coordinator = new ExecutionPolicyCoordinator({ workspaceRoot: profile.workspaceRoot,
		constraints: { ...constraints, ...(constraints.deniedReadGlobs?.length ? {
			deniedReadRoots: resolveDeniedReadRoots(workspaceRoot, constraints), deniedReadGlobs: [],
		} : {}) } });
	// This is a new integration process: seed configured authority before freezing it.
	const initial = { ...profile,
		...(constraints.allowLocalBinding === undefined ? {} : { allowLocalBinding: constraints.allowLocalBinding }),
		...(constraints.loopbackPorts === undefined ? {} : {
			loopbackPorts: constraints.loopbackPorts, networkDomains: constraints.networkDomains,
		}),
		...(constraints.networkProxy === undefined ? {} : {
			networkProxy: constraints.networkProxy, networkDomains: constraints.networkDomains,
		}),
	};
	return offlineProcessProfile(Object.freeze({ ...profile, ...coordinator.restoreTurn("process", { toolsEnabled: true, profile: initial }).profile }));
}

function offlineProcessProfile(profile: SandboxProfile): SandboxProfile {
	if (profile.network !== "disabled") return profile;
	const { networkEgress, ...offline } = profile;
	// An offline process cannot use an egress exception. Retain the network deny
	// while keeping the native request free of contradictory network modes.
	return networkEgress === undefined ? profile : Object.freeze(offline);
}
