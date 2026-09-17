import { basename, dirname } from "node:path";
import type { PluginCandidate } from "./types.ts";
import { isObject } from "./package-files.ts";

export interface PluginDeclarations {
	readonly skills: readonly string[];
	readonly mcpServers: readonly string[];
	readonly hooks: readonly string[];
	readonly tools: readonly string[];
	readonly commands: readonly string[];
}

/** Declared names only; never evaluates plugin code or expands environment values. */
export function pluginDeclarations(candidate: PluginCandidate | undefined): PluginDeclarations {
	if (candidate?.kind === "plugin") return { skills: [], mcpServers: [], ...candidate.manifest.provides };
	if (candidate?.kind !== "bundle") return { skills: [], mcpServers: [], hooks: [], tools: [], commands: [] };
	const keys = (value: unknown): string[] => isObject(value) ? Object.keys(value) : [];
	return {
		skills: candidate.manifest.skillFiles.map((path) => basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path)),
		mcpServers: candidate.manifest.mcp.flatMap((document) => keys(document.mcpServers ?? document.mcp_servers ?? document)),
		hooks: candidate.manifest.hooks.flatMap((document) => {
			const hooks = document.hooks ?? document;
			return Array.isArray(hooks) ? hooks.flatMap((hook: unknown) => isObject(hook) && typeof hook.hook_point === "string" ? [hook.hook_point] : []) : keys(hooks);
		}), tools: [], commands: [],
	};
}
