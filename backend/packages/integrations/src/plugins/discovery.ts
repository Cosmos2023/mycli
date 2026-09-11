import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { loadPluginManifest } from "./manifest.ts";
import { findBundleManifest, loadPluginBundle } from "./bundle-manifest.ts";
import { isPluginId, PluginPackageError } from "./package-files.ts";
import { pluginCacheRoot, readPluginPackageRegistry, type InstalledPluginPackage } from "./package-registry.ts";
import type {
	DiscoveredPlugin,
	InvalidPluginCandidate,
	PluginCandidate,
	PluginDiagnostic,
	PluginDiagnosticSource,
	PluginDiscovery,
	PluginEnablement,
	PluginMigrationDiagnostic,
	PluginSource,
} from "./types.ts";

export interface DiscoverPluginsOptions {
	readonly workspaceRoot: string;
	readonly homeDir: string;
	readonly includeRepository?: boolean;
	readonly maxPlugins?: number;
}

interface PluginDirectory {
	readonly source: PluginSource;
	readonly root: string;
}

interface ConfigRead {
	readonly exists: boolean;
	readonly source: Exclude<PluginDiagnosticSource, "discovery">;
	readonly fileLabel: string;
	readonly payload?: Readonly<Record<string, unknown>>;
	readonly diagnostic?: PluginDiagnostic;
}

const DEFAULT_MAX_PLUGINS = 256;
const MAX_PLUGINS = 1_024;
const LEGACY_MANIFEST_MAX_BYTES = 65_536;
const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,63}(?:@[a-z0-9][a-z0-9._-]{0,63})?$/u;
const MIGRATION_MESSAGE = "Python plugin requires Plugin API v2 migration" as const;

export async function discoverPlugins(
	options: DiscoverPluginsOptions,
): Promise<PluginDiscovery> {
	const maxPlugins = pluginLimit(options.maxPlugins);
	let installed: readonly InstalledPluginPackage[] = [];
	let registryIssue: PluginDiagnostic | undefined;
	try { installed = (await readPluginPackageRegistry(options.homeDir)).plugins; }
	catch { registryIssue = diagnostic("user", "plugins", "plugin-registry.json", "plugin_registry_invalid"); }
	const enablement = await loadEnablement(options, installed);
	const directories: readonly PluginDirectory[] = [
		...(options.includeRepository === false
			? []
			: [{
				source: "repo" as const,
				root: join(options.workspaceRoot, ".mycli", "plugins"),
			}]),
		{ source: "user", root: join(options.homeDir, ".mycli", "plugins") },
	];
	const candidates: PluginCandidate[] = [];
	const diagnostics: PluginDiagnostic[] = [...enablement.issues, ...(registryIssue ? [registryIssue] : [])];
	let discovered = 0;

	for (const directory of directories) {
		let pluginRoots: readonly string[];
		try {
			pluginRoots = await pluginDirectories(directory.root);
		} catch {
			diagnostics.push(diagnostic(directory.source, "plugins", "plugins", "directory_read_failed"));
			continue;
		}
		for (const pluginRoot of pluginRoots) {
			discovered += 1;
			const pluginId = basename(pluginRoot);
			if (discovered > maxPlugins) {
				const invalid = invalidCandidate(
					directory.source,
					pluginId,
					enablement.isEnabled(pluginId),
					"plugin_limit_exceeded",
				);
				candidates.push(invalid);
				diagnostics.push(invalid.diagnostic);
				continue;
			}
			const candidate = await discoverCandidate(
				directory.source,
				pluginRoot,
				enablement.isEnabled(pluginId),
			);
			candidates.push(candidate);
			if (candidate.kind === "invalid") diagnostics.push(candidate.diagnostic);
		}
	}

	for (const item of installed) {
		if (++discovered > maxPlugins) {
			diagnostics.push(diagnostic("user", item.id, "plugins", "plugin_limit_exceeded"));
			continue;
		}
		const candidate = await discoverCandidate("user", pluginCacheRoot(options.homeDir, item.cacheKey), enablement.isEnabled(item.id), item.id);
		candidates.push(candidate);
		if (candidate.kind === "invalid") diagnostics.push(candidate.diagnostic);
	}
	const selectedById = new Map<string, PluginCandidate>();
	const duplicateIds = new Set<string>();
	for (const candidate of candidates) {
		if (selectedById.has(candidate.pluginId)) duplicateIds.add(candidate.pluginId);
		selectedById.set(candidate.pluginId, candidate);
	}
	const selected = [...selectedById.values()]
		.sort((left, right) => compareText(left.pluginId, right.pluginId))
		.map((candidate) => duplicateIds.has(candidate.pluginId)
			? Object.freeze({ ...candidate, duplicate: true }) as PluginCandidate
			: candidate);
	for (const pluginId of [...duplicateIds].sort(compareText)) {
		diagnostics.push(diagnostic("discovery", pluginId, "plugins", "duplicate_plugin_id"));
	}

	const plugins = selected.filter((candidate): candidate is DiscoveredPlugin => (
		candidate.kind === "plugin"
	));
	const names = new Map<string, string[]>();
	for (const plugin of plugins) {
		const ids = names.get(plugin.manifest.name) ?? [];
		ids.push(plugin.pluginId);
		names.set(plugin.manifest.name, ids);
	}
	for (const ids of names.values()) {
		if (new Set(ids).size > 1) {
			diagnostics.push(diagnostic(
				"discovery",
				[...ids].sort(compareText)[0] ?? "plugin",
				"plugins",
				"duplicate_plugin_name",
			));
		}
	}
	const migrations = candidates.filter((candidate): candidate is PluginMigrationDiagnostic => (
		candidate.kind === "migration_required"
	));
	const selectedMap = new Map(selected.map((candidate) => [candidate.pluginId, candidate]));
	return Object.freeze({
		candidates: Object.freeze(candidates),
		selected: Object.freeze(selected),
		plugins: Object.freeze(plugins),
		migrations: Object.freeze(migrations),
		diagnostics: Object.freeze(diagnostics),
		enablement,
		get: (pluginId: string) => selectedMap.get(pluginId),
	});
}

async function discoverCandidate(
	source: PluginSource,
	pluginRoot: string,
	enabled: boolean,
	installedId?: string,
): Promise<PluginCandidate> {
	const rawId = installedId ?? basename(pluginRoot);
	const pluginId = safePluginId(rawId);
	if (pluginId !== rawId) {
		return invalidCandidate(source, pluginId, enabled, "invalid_plugin_id");
	}
	try {
		if (await findBundleManifest(pluginRoot)) {
			const manifest = await loadPluginBundle(pluginRoot, pluginId.split("@")[0]);
			if (manifest.name !== pluginId.split("@")[0]) return invalidCandidate(source, pluginId, enabled, "plugin_name_mismatch");
			return Object.freeze({ kind: "bundle", pluginId, source, enabled, duplicate: false, manifest });
		}
	} catch (error) {
		return invalidCandidate(source, pluginId, enabled, error instanceof PluginPackageError ? error.code : "plugin_manifest_invalid");
	}
	if (await requiresMigration(pluginRoot)) {
		return Object.freeze({
			kind: "migration_required",
			pluginId,
			source,
			enabled,
			duplicate: false,
			message: MIGRATION_MESSAGE,
		});
	}
	const loaded = await loadPluginManifest({
		pluginRoot,
		source,
		expectedPluginId: installedId ? pluginId.split("@")[0] : pluginId,
	});
	if (loaded.kind === "invalid") {
		return Object.freeze({
			kind: "invalid",
			pluginId,
			source,
			enabled,
			duplicate: false,
			diagnostic: loaded.diagnostic,
		});
	}
	return Object.freeze({
		kind: "plugin",
		pluginId,
		source,
		enabled,
		duplicate: false,
		manifest: loaded.manifest,
	});
}

async function requiresMigration(pluginRoot: string): Promise<boolean> {
	try {
		if ((await stat(join(pluginRoot, "__init__.py"))).isFile()) return true;
	} catch (error) {
		if (errorCode(error) !== "ENOENT") return false;
	}
	const manifestPath = join(pluginRoot, "plugin.yaml");
	try {
		const metadata = await stat(manifestPath);
		if (!metadata.isFile() || metadata.size > LEGACY_MANIFEST_MAX_BYTES) return false;
		const payload = parseYaml(await readFile(manifestPath, "utf8"));
		return !isRecord(payload) || payload.api_version !== 2;
	} catch {
		return false;
	}
}

async function pluginDirectories(root: string): Promise<readonly string[]> {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
	return Object.freeze(entries
		.filter((entry) => entry.isDirectory())
		.sort((left, right) => compareText(left.name, right.name))
		.map((entry) => join(root, entry.name)));
}

async function loadEnablement(options: DiscoverPluginsOptions, installed: readonly InstalledPluginPackage[]): Promise<PluginEnablement> {
	const modernUserPath = join(options.homeDir, ".mycli", "config.toml");
	const modernUser = await readConfig(modernUserPath, "user");
	const repo = options.includeRepository === false
		? undefined
		: await readConfig(
			join(options.workspaceRoot, ".mycli", "config.toml"),
			"repo",
		);
	const legacy = modernUser.exists
		? undefined
		: await readConfig(join(options.homeDir, ".config", "mycli", "config.toml"), "legacy_user");
	const enabled = new Set<string>();
	const disabled = new Set<string>();
	const issues: PluginDiagnostic[] = [];
	for (const config of [modernUser, ...(repo ? [repo] : []), ...(legacy ? [legacy] : [])]) {
		if (config.diagnostic) issues.push(config.diagnostic);
		if (!config.payload) continue;
		const plugins = config.payload.plugins;
		if (plugins === undefined) continue;
		if (!isRecord(plugins)) {
			issues.push(diagnostic(
				config.source,
				"config",
				config.fileLabel,
				"invalid_plugins_table",
			));
			continue;
		}
		for (const id of stringIds(plugins.enabled)) enabled.add(id);
		for (const id of stringIds(plugins.disabled)) disabled.add(id);
	}
	for (const item of installed) {
		if (!enabled.has(item.id) && !disabled.has(item.id)) (item.enabled ? enabled : disabled).add(item.id);
	}
	const enabledIds = Object.freeze([...enabled].sort(compareText));
	const disabledIds = Object.freeze([...disabled].sort(compareText));
	return Object.freeze({
		enabledIds,
		disabledIds,
		issues: Object.freeze(issues),
		isEnabled: (pluginId: string) => enabled.has(pluginId) && !disabled.has(pluginId),
	});
}

async function readConfig(
	path: string,
	source: Exclude<PluginDiagnosticSource, "discovery">,
): Promise<ConfigRead> {
	const fileLabel = basename(path);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return { exists: false, source, fileLabel };
		return {
			exists: true,
			source,
			fileLabel,
			diagnostic: diagnostic(source, "config", fileLabel, "config_read_failed"),
		};
	}
	try {
		const parsed = parseToml(raw);
		if (!isRecord(parsed)) throw new Error("invalid root");
		return { exists: true, source, fileLabel, payload: parsed };
	} catch {
		return {
			exists: true,
			source,
			fileLabel,
			diagnostic: diagnostic(source, "config", fileLabel, "invalid_toml"),
		};
	}
}

function stringIds(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => (
		typeof item === "string" && isPluginId(item.trim()) ? [item.trim()] : []
	));
}

function invalidCandidate(
	source: PluginSource,
	pluginIdValue: string,
	enabled: boolean,
	errorClass: string,
): InvalidPluginCandidate {
	const pluginId = safePluginId(pluginIdValue);
	return Object.freeze({
		kind: "invalid",
		pluginId,
		source,
		enabled,
		duplicate: false,
		diagnostic: diagnostic(source, pluginId, "plugin.yaml", errorClass),
	});
}

function diagnostic(
	source: PluginDiagnosticSource,
	pluginIdValue: string,
	fileLabel: string,
	errorClass: string,
): PluginDiagnostic {
	return Object.freeze({
		source,
		pluginId: safePluginId(pluginIdValue),
		fileLabel: basename(fileLabel).slice(0, 64) || "plugins",
		errorClass: errorClass.slice(0, 64),
	});
}

function safePluginId(value: string): string {
	return PLUGIN_ID.test(value) ? value : "plugin";
}

function pluginLimit(value: number | undefined): number {
	const selected = value ?? DEFAULT_MAX_PLUGINS;
	if (!Number.isSafeInteger(selected) || selected <= 0 || selected > MAX_PLUGINS) {
		throw new RangeError("invalid_plugin_limit");
	}
	return selected;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
