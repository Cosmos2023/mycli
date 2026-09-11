import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { atomicPrivateFileUpdate } from "@mycli/config";
import { findBundleManifest, loadPluginBundle } from "./bundle-manifest.ts";
import { loadPluginManifest } from "./manifest.ts";
import { discoverPlugins } from "./discovery.ts";
import { isMissing, isObject, isPluginId, PluginPackageError } from "./package-files.ts";
import { pluginCacheRoot, readPluginPackageRegistry, updatePluginPackageRegistry,
	type InstalledPluginPackage, type PluginPackageSource } from "./package-registry.ts";
import { loadMarketplace, resolvePackageSource, stagePluginSource } from "./package-source.ts";

export type PluginPackageRequest =
	| { readonly action: "add"; readonly source: string; readonly marketplace?: string; readonly ref?: string }
	| { readonly action: "remove" | "enable" | "disable" | "update"; readonly pluginId: string }
	| { readonly action: "available"; readonly marketplace?: string }
	| { readonly action: "marketplace"; readonly operation: "add" | "remove" | "upgrade" | "list"; readonly target?: string; readonly ref?: string };

export interface PluginPackageResponse {
	readonly ok: boolean;
	readonly action: string;
	readonly message: string;
	readonly issues: readonly string[];
	readonly plugins?: readonly { readonly pluginId: string; readonly enabled?: boolean; readonly status: string; readonly version?: string }[];
	readonly marketplaces?: readonly { readonly name: string; readonly source: "local" | "git" }[];
}

export interface PluginPackageManagerOptions {
	readonly homeDir: string;
	readonly workspaceRoot: string;
	readonly includeRepository?: boolean;
	readonly stageSource?: typeof stagePluginSource;
}

export class PluginPackageManager {
	readonly #options: PluginPackageManagerOptions;
	readonly #stage: typeof stagePluginSource;

	constructor(options: PluginPackageManagerOptions) { this.#options = options; this.#stage = options.stageSource ?? stagePluginSource; }

	async execute(request: PluginPackageRequest, signal: AbortSignal): Promise<PluginPackageResponse> {
		signal.throwIfAborted();
		try {
			if (request.action === "marketplace") return await this.#marketplace(request, signal);
			if (request.action === "available") return await this.#available(request.marketplace);
			if (request.action === "add") return await this.#install(request, signal);
			if (!isPluginId(request.pluginId)) throw new PluginPackageError("invalid_plugin_id");
			const registry = await readPluginPackageRegistry(this.#options.homeDir);
			const previous = registry.plugins.find((item) => item.id === request.pluginId);
			if (request.action === "enable" || request.action === "disable") {
				const enabled = request.action === "enable";
				const discovery = await discoverPlugins(this.#options);
				if (!discovery.get(request.pluginId)) throw new PluginPackageError("plugin_not_found");
				await setPluginEnablement(this.#options.homeDir, request.pluginId, enabled, signal);
				if (enabled && !(await discoverPlugins(this.#options)).enablement.isEnabled(request.pluginId)) {
					return { ...success(request.action, `Plugin ${request.pluginId} remains disabled by repository configuration.`),
						ok: false, issues: ["plugin_disabled_by_configuration"] };
				}
				return success(request.action, `Plugin ${request.pluginId} ${enabled ? "enabled" : "disabled"}. Restart active sessions to apply.`);
			}
			if (!previous) throw new PluginPackageError("plugin_not_managed");
			if (request.action === "update") return await this.#install({ action: "add", source: previous.id }, signal, previous);
			await updatePluginPackageRegistry(this.#options.homeDir, signal, (state) => {
				if (state.plugins.find((item) => item.id === previous.id)?.cacheKey !== previous.cacheKey) throw new PluginPackageError("plugin_install_conflict");
				return { ...state, plugins: state.plugins.filter((item) => item.id !== previous.id) };
			});
			// Active sessions retain the immutable snapshot until they close.
			return success("remove", `Plugin ${previous.id} removed. Restart active sessions to apply.`);
		} catch (error) {
			if (signal.aborted) throw error;
			const code = error instanceof PluginPackageError ? error.code : "plugin_package_operation_failed";
			return { ok: false, action: request.action, message: `Plugin operation failed: ${code}`, issues: [code] };
		}
	}

	async #install(request: Extract<PluginPackageRequest, { readonly action: "add" }>, signal: AbortSignal, previous?: InstalledPluginPackage): Promise<PluginPackageResponse> {
		let source: PluginPackageSource;
		let marketplace = request.marketplace ?? previous?.marketplace;
		let name: string | undefined;
		if (request.source.includes("@") && !request.source.startsWith("git@") && !request.source.includes("/")) {
			const parts = request.source.split("@");
			if (parts.length !== 2 || marketplace && marketplace !== parts[1]) throw new PluginPackageError("plugin_selector_invalid");
			[name, marketplace] = parts;
		} else if (marketplace) name = request.source;
		if (marketplace) {
			if (request.ref !== undefined) throw new PluginPackageError("plugin_ref_requires_git");
			name ??= previous?.id.split("@")[0];
			const selected = (await readPluginPackageRegistry(this.#options.homeDir)).marketplaces.find((item) => item.name === marketplace);
			if (!selected) throw new PluginPackageError("plugin_marketplace_not_configured");
			const catalog = await loadMarketplace(pluginCacheRoot(this.#options.homeDir, selected.cacheKey));
			const entry = catalog.entries.find((item) => item.name === name);
			if (!entry || !entry.available) throw new PluginPackageError("plugin_not_available");
			source = entry.source;
		} else source = previous?.source ?? await resolvePackageSource(request.source, this.#options.workspaceRoot, this.#options.homeDir, request.ref);
		const cacheKey = randomUUID();
		const root = pluginCacheRoot(this.#options.homeDir, cacheKey);
		let committed = false;
		try {
			await this.#stage(source, root, signal);
			const fallbackName = name ?? previous?.id.split("@")[0]
				?? basename(source.kind === "local" ? source.path : source.path ?? source.url).replace(/\.git$/u, "");
			const manifest = await packageMetadata(root, fallbackName);
			if (name && manifest.name !== name) throw new PluginPackageError("plugin_name_mismatch");
			const id = marketplace ? `${manifest.name}@${marketplace}` : manifest.name;
			if (previous && previous.id !== id) throw new PluginPackageError("plugin_name_mismatch");
			const installed: InstalledPluginPackage = { id, cacheKey, enabled: previous?.enabled ?? true, source,
				...(manifest.version ? { version: manifest.version } : {}), ...(marketplace ? { marketplace } : {}) };
			await updatePluginPackageRegistry(this.#options.homeDir, signal, (state) => {
				const current = state.plugins.find((item) => item.id === id);
				if (previous ? current?.cacheKey !== previous.cacheKey : current !== undefined) throw new PluginPackageError("plugin_install_conflict");
				return { ...state, plugins: [...state.plugins.filter((item) => item.id !== id), installed] };
			});
			committed = true;
			const enabled = (await discoverPlugins(this.#options)).enablement.isEnabled(id);
			return { ...success(previous ? "update" : "add", `Plugin ${id} ${previous ? "updated" : "installed"}. Restart active sessions to apply.`),
				issues: manifest.issues, plugins: [{ pluginId: id, enabled, status: manifest.issues.length ? "partial" : "installed", version: installed.version }] };
		} finally {
			if (!committed) await rm(root, { recursive: true, force: true });
			// Existing sessions may still resolve resources from their captured package snapshot.
		}
	}

	async #available(marketplace?: string): Promise<PluginPackageResponse> {
		const state = await readPluginPackageRegistry(this.#options.homeDir);
		const { enablement } = await discoverPlugins(this.#options);
		const plugins: NonNullable<PluginPackageResponse["plugins"]>[number][] = [];
		if (marketplace && !state.marketplaces.some((item) => item.name === marketplace)) throw new PluginPackageError("plugin_marketplace_not_configured");
		for (const entry of state.marketplaces.filter((item) => !marketplace || item.name === marketplace)) {
			for (const item of (await loadMarketplace(pluginCacheRoot(this.#options.homeDir, entry.cacheKey))).entries) {
				const pluginId = `${item.name}@${entry.name}`;
				const installed = state.plugins.find((plugin) => plugin.id === pluginId);
				plugins.push({ pluginId, status: installed ? "installed" : item.available ? "available" : "unavailable",
					...(installed ? { enabled: enablement.isEnabled(installed.id), version: installed.version } : {}) });
			}
		}
		return { ...success("list", `plugins: ${plugins.length} available entries`), plugins };
	}

	async #marketplace(request: Extract<PluginPackageRequest, { readonly action: "marketplace" }>, signal: AbortSignal): Promise<PluginPackageResponse> {
		const state = await readPluginPackageRegistry(this.#options.homeDir);
		if (request.operation === "list") return { ...success("marketplace", `marketplaces: ${state.marketplaces.length}`),
			marketplaces: state.marketplaces.map((item) => ({ name: item.name, source: item.source.kind })) };
		const previous = state.marketplaces.find((item) => item.name === request.target);
		if (request.operation === "remove") {
			if (!previous) throw new PluginPackageError("plugin_marketplace_not_configured");
			await updatePluginPackageRegistry(this.#options.homeDir, signal, (current) => {
				if (current.marketplaces.find((item) => item.name === previous.name)?.cacheKey !== previous.cacheKey) throw new PluginPackageError("plugin_install_conflict");
				return { ...current, marketplaces: current.marketplaces.filter((item) => item.name !== previous.name) };
			});
			return success("marketplace", `Marketplace ${previous.name} removed. Installed plugins are retained.`);
		}
		if (request.operation === "upgrade" && !previous) throw new PluginPackageError("plugin_marketplace_not_configured");
		const source = previous?.source ?? await resolvePackageSource(request.target ?? "", this.#options.workspaceRoot, this.#options.homeDir, request.ref);
		const cacheKey = randomUUID();
		const root = pluginCacheRoot(this.#options.homeDir, cacheKey);
		let committed = false;
		try {
			await this.#stage(source, root, signal);
			const manifest = await loadMarketplace(root);
			if (previous && manifest.name !== previous.name) throw new PluginPackageError("plugin_marketplace_name_mismatch");
			await updatePluginPackageRegistry(this.#options.homeDir, signal, (current) => {
				const existing = current.marketplaces.find((item) => item.name === manifest.name);
				if (previous ? existing?.cacheKey !== previous.cacheKey : existing !== undefined) throw new PluginPackageError("plugin_install_conflict");
				return { ...current, marketplaces: [...current.marketplaces.filter((item) => item.name !== manifest.name), { name: manifest.name, source, cacheKey }] };
			});
			committed = true;
			return success("marketplace", `Marketplace ${manifest.name} ${previous ? "upgraded" : "added"}.`);
		} finally { if (!committed) await rm(root, { recursive: true, force: true }); }
	}
}

async function packageMetadata(root: string, fallbackName: string): Promise<{ readonly name: string; readonly version?: string; readonly issues: readonly string[] }> {
	if (await findBundleManifest(root)) return loadPluginBundle(root, fallbackName);
	const result = await loadPluginManifest({ pluginRoot: root, source: "user" });
	if (result.kind !== "loaded") throw new PluginPackageError(result.diagnostic.errorClass);
	return { name: result.manifest.id, version: result.manifest.version, issues: [] };
}

async function setPluginEnablement(homeDir: string, id: string, enabled: boolean, signal: AbortSignal): Promise<void> {
	await atomicPrivateFileUpdate({ directory: join(homeDir, ".mycli"), fileName: "config.toml", signal,
		buildContent: async (current) => {
			let content = current;
			if (content === undefined) {
				try { content = await readFile(join(homeDir, ".config", "mycli", "config.toml"), "utf8"); }
				catch (error) { if (!isMissing(error)) throw new PluginPackageError("plugin_config_invalid"); }
			}
			const config = content === undefined ? {} : parseToml(content);
			const previous = config.plugins;
			if (previous !== undefined && !isObject(previous)) throw new PluginPackageError("plugin_config_invalid");
			const table = previous ?? {};
			const ids = (value: unknown): string[] => {
				if (value === undefined) return [];
				if (!Array.isArray(value) || !value.every(isPluginId)) throw new PluginPackageError("plugin_config_invalid");
				return value.filter((item) => item !== id);
			};
			return stringifyToml({ ...config, plugins: { ...table, enabled: [...ids(table.enabled), ...(enabled ? [id] : [])],
				disabled: [...ids(table.disabled), ...(enabled ? [] : [id])] } });
		},
	});
}

function success(action: string, message: string): PluginPackageResponse { return { ok: true, action, message, issues: [] }; }
