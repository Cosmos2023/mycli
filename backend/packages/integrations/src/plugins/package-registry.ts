import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicPrivateFileUpdate } from "@mycli/config";
import { isMissing, isObject, isPluginId, PluginPackageError } from "./package-files.ts";

export type PluginPackageSource =
	| { readonly kind: "local"; readonly path: string }
	| { readonly kind: "git"; readonly url: string; readonly ref?: string; readonly path?: string; readonly sha?: string };

export interface InstalledPluginPackage {
	readonly id: string;
	readonly cacheKey: string;
	readonly enabled: boolean;
	readonly version?: string;
	readonly source: PluginPackageSource;
	readonly marketplace?: string;
}

export interface InstalledPluginMarketplace {
	readonly name: string;
	readonly cacheKey: string;
	readonly source: PluginPackageSource;
}

export interface PluginPackageRegistry {
	readonly version: 1;
	readonly plugins: readonly InstalledPluginPackage[];
	readonly marketplaces: readonly InstalledPluginMarketplace[];
}

const EMPTY: PluginPackageRegistry = Object.freeze({ version: 1, plugins: [], marketplaces: [] });
const CACHE_KEY = /^[a-f0-9-]{36}$/u;

export function pluginCacheRoot(homeDir: string, cacheKey: string): string {
	if (!CACHE_KEY.test(cacheKey)) throw new PluginPackageError("plugin_registry_invalid");
	return join(homeDir, ".mycli", "plugin-cache", cacheKey);
}

export async function readPluginPackageRegistry(homeDir: string): Promise<PluginPackageRegistry> {
	try { return parseRegistry(await readFile(join(homeDir, ".mycli", "plugin-registry.json"), "utf8")); }
	catch (error) { if (isMissing(error)) return EMPTY; throw new PluginPackageError("plugin_registry_invalid"); }
}

export async function updatePluginPackageRegistry(
	homeDir: string, signal: AbortSignal,
	update: (registry: PluginPackageRegistry) => PluginPackageRegistry,
): Promise<void> {
	await atomicPrivateFileUpdate({ directory: join(homeDir, ".mycli"), fileName: "plugin-registry.json", signal,
		buildContent: (current) => {
			const content = JSON.stringify(update(current === undefined ? EMPTY : parseRegistry(current)), null, 2) + "\n";
			parseRegistry(content);
			return content;
		},
	});
}

function parseRegistry(raw: string): PluginPackageRegistry {
	if (Buffer.byteLength(raw) > 1_048_576) throw new PluginPackageError("plugin_registry_invalid");
	let value: unknown;
	try { value = JSON.parse(raw); } catch { throw new PluginPackageError("plugin_registry_invalid"); }
	if (!isObject(value) || value.version !== 1 || !Array.isArray(value.plugins) || !Array.isArray(value.marketplaces)
		|| value.plugins.length > 1_024 || value.marketplaces.length > 128) throw new PluginPackageError("plugin_registry_invalid");
	const plugins = value.plugins.map((item): InstalledPluginPackage => {
		if (!isObject(item) || !isPluginId(item.id) || typeof item.cacheKey !== "string" || !CACHE_KEY.test(item.cacheKey)
			|| typeof item.enabled !== "boolean" || item.version !== undefined && typeof item.version !== "string"
			|| item.marketplace !== undefined && (!isPluginId(item.marketplace) || item.marketplace.includes("@"))) throw new PluginPackageError("plugin_registry_invalid");
		return { id: item.id, cacheKey: item.cacheKey, enabled: item.enabled, source: parseSource(item.source),
			...(typeof item.version === "string" ? { version: item.version } : {}),
			...(typeof item.marketplace === "string" ? { marketplace: item.marketplace } : {}) };
	});
	const marketplaces = value.marketplaces.map((item): InstalledPluginMarketplace => {
		if (!isObject(item) || !isPluginId(item.name) || item.name.includes("@") || typeof item.cacheKey !== "string" || !CACHE_KEY.test(item.cacheKey)) throw new PluginPackageError("plugin_registry_invalid");
		return { name: item.name, cacheKey: item.cacheKey, source: parseSource(item.source) };
	});
	if (new Set(plugins.map((item) => item.id)).size !== plugins.length || new Set(marketplaces.map((item) => item.name)).size !== marketplaces.length) throw new PluginPackageError("plugin_registry_invalid");
	return Object.freeze({ version: 1, plugins: Object.freeze(plugins), marketplaces: Object.freeze(marketplaces) });
}

function parseSource(value: unknown): PluginPackageSource {
	if (!isObject(value)) throw new PluginPackageError("plugin_registry_invalid");
	if (value.kind === "local" && typeof value.path === "string") return { kind: "local", path: value.path };
	if (value.kind === "git" && typeof value.url === "string" && [value.ref, value.path, value.sha].every((item) => item === undefined || typeof item === "string")) {
		return { kind: "git", url: value.url, ...(typeof value.ref === "string" ? { ref: value.ref } : {}),
			...(typeof value.path === "string" ? { path: value.path } : {}), ...(typeof value.sha === "string" ? { sha: value.sha } : {}) };
	}
	throw new PluginPackageError("plugin_registry_invalid");
}
