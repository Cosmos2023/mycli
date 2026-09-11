import { basename, join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { containedPath, isMissing, isObject, isPluginId, optionalFile, PluginPackageError, readPackageJson } from "./package-files.ts";

export interface PluginBundleManifest {
	readonly format: "codex";
	readonly name: string;
	readonly displayName: string;
	readonly version?: string;
	readonly description: string;
	readonly pluginRoot: string;
	readonly manifestPath: string;
	readonly skillFiles: readonly string[];
	readonly mcp: readonly Readonly<Record<string, unknown>>[];
	readonly hooks: readonly Readonly<Record<string, unknown>>[];
	readonly issues: readonly string[];
}

export async function findBundleManifest(root: string): Promise<string | undefined> {
	for (const path of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]) {
		if (await optionalFile(join(root, path))) return containedPath(root, path);
	}
	return undefined;
}

export async function loadPluginBundle(root: string, fallbackName = basename(root).split("@")[0]!): Promise<PluginBundleManifest> {
	const manifestPath = await findBundleManifest(root);
	if (!manifestPath) throw new PluginPackageError("plugin_manifest_missing");
	const value = await readPackageJson(manifestPath);
	const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : fallbackName;
	if (!isPluginId(name) || name.includes("@")) throw new PluginPackageError("invalid_plugin_name");
	const issues: string[] = [];
	const components = async (field: unknown, fallback: string): Promise<readonly Readonly<Record<string, unknown>>[]> => {
		const items = field === undefined ? await optionalFile(join(root, fallback)) ? [`./${fallback}`] : [] : Array.isArray(field) ? field : [field];
		const result: Readonly<Record<string, unknown>>[] = [];
		if (items.length > 64) throw new PluginPackageError("plugin_component_limit_exceeded");
		for (const item of items) {
			if (isObject(item)) result.push(item);
			else result.push(await readPackageJson(await componentPath(root, item)));
		}
		return Object.freeze(result);
	};
	const skillFiles: string[] = [];
	const skillPaths = value.skills === undefined ? ["./skills"] : Array.isArray(value.skills) ? value.skills : [value.skills];
	if (skillPaths.length > 256) throw new PluginPackageError("plugin_skill_limit_exceeded");
	for (const path of skillPaths) {
		if (path === "./skills" && value.skills === undefined) {
			try { await stat(join(root, "skills")); } catch (error) { if (isMissing(error)) continue; throw error; }
		}
		const resolved = await componentPath(root, path);
		if ((await stat(resolved)).isFile()) skillFiles.push(resolved);
		else if (await optionalFile(join(resolved, "SKILL.md"))) skillFiles.push(await containedPath(root, join(resolved, "SKILL.md")));
		else for (const entry of (await readdir(resolved, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			const candidate = join(resolved, entry.name, "SKILL.md");
			if ((entry.isDirectory() || entry.isSymbolicLink()) && await optionalFile(candidate)) skillFiles.push(await containedPath(root, candidate));
		}
	}
	if (skillFiles.length > 256) throw new PluginPackageError("plugin_skill_limit_exceeded");
	if (value.apps !== undefined || await optionalFile(join(root, ".app.json"))) {
		await components(value.apps, ".app.json");
		issues.push("plugin_apps_unavailable");
	}
	const ui = isObject(value.interface) ? value.interface : {};
	return Object.freeze({ format: "codex", name, displayName: boundedText(ui.displayName, name, 128),
		...(typeof value.version === "string" ? { version: boundedText(value.version, "unversioned", 64) } : {}),
		description: boundedText(value.description ?? ui.shortDescription, "", 1_024), pluginRoot: root, manifestPath,
		skillFiles: Object.freeze([...new Set(skillFiles)]), mcp: await components(value.mcpServers, ".mcp.json"),
		hooks: await components(value.hooks, "hooks/hooks.json"), issues: Object.freeze(issues),
	});
}

async function componentPath(root: string, value: unknown): Promise<string> {
	if (typeof value !== "string" || !value.startsWith("./") || value.includes("\\") || value.split("/").includes("..")) throw new PluginPackageError("plugin_path_invalid");
	try { return await containedPath(root, value); }
	catch (error) { throw error instanceof PluginPackageError ? error : new PluginPackageError("plugin_component_missing"); }
}

function boundedText(value: unknown, fallback: string, maximum: number): string {
	return typeof value === "string" ? value.replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim().slice(0, maximum) : fallback;
}
