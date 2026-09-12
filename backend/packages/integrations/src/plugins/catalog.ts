import { createHash } from "node:crypto";
import type { PluginCapabilitySummary, PluginCatalog, PluginCatalogEntry, PluginChange, PluginDetail } from "@mycli/contracts";
import { discoverPlugins } from "./discovery.ts";
import { findBundleManifest, loadPluginBundle } from "./bundle-manifest.ts";
import { loadPluginManifest } from "./manifest.ts";
import { isPluginId, PluginPackageError } from "./package-files.ts";
import { pluginDeclarations } from "./declarations.ts";
import { PluginPackageManager, type PluginPackageManagerOptions, type PluginPackageRequest, type PluginPackageResponse } from "./package-management.ts";
import { pluginCacheRoot, readPluginPackageRegistry, type PluginPackageRegistry, type PluginPackageSource } from "./package-registry.ts";
import { loadMarketplace } from "./package-source.ts";
import type { PluginCandidate } from "./types.ts";

const MAX_CATALOG_ENTRIES = 2_048;

type Metadata = Pick<PluginCatalogEntry, "name" | "description" | "version" | "capabilities" | "issues" | "status">;
interface CatalogSnapshot {
	readonly catalog: PluginCatalog;
	readonly registry: PluginPackageRegistry;
	readonly candidates: ReadonlyMap<string, PluginCandidate>;
}

/** Package metadata only: no host imports, MCP connections, hooks or provider calls. */
export class PluginCatalogService {
	constructor(private readonly options: PluginPackageManagerOptions) {}

	async list(signal: AbortSignal, marketplace?: string): Promise<PluginCatalog> {
		return (await this.snapshot(signal, marketplace)).catalog;
	}

	async inspect(target: string, expectedRevision: string, signal: AbortSignal): Promise<PluginDetail> {
		const { catalog, candidates } = await this.snapshot(signal, target.split("@")[1]);
		const plugin = catalog.plugins.find((item) => item.id === target);
		if (!plugin || plugin.revision !== expectedRevision) throw new PluginPackageError("plugin_catalog_changed");
		const candidate = candidates.get(target);
		if (!candidate || candidate.kind === "invalid" || candidate.kind === "migration_required") return { plugin, details: [] };
		const declared = pluginDeclarations(candidate);
		const details = Object.entries(declared).flatMap(([kind, names]) => [
			`${kind === "mcpServers" ? "MCP servers" : kind[0]!.toUpperCase() + kind.slice(1)} (${names.length}):`,
			...(names.length ? names.map((name: string) => `  ${safeText(name, 1000)}`) : ["  None"]),
		]);
		return { plugin, details: details.length > 1024 ? [...details.slice(0, 1023), `${details.length - 1023} more declarations omitted.`] : details };
	}

	async change(change: PluginChange, signal: AbortSignal): Promise<PluginPackageResponse> {
		const manager = new PluginPackageManager(this.options);
		if (change.action === "install_source" || change.action === "marketplace_add") {
			return manager.execute(change.action === "install_source" ? { action: "add", source: change.source }
				: { action: "marketplace", operation: "add", target: change.source }, signal);
		}
		if (!("target" in change)) throw new PluginPackageError("plugin_source_invalid");
		const isMarketplace = change.action === "marketplace_upgrade" || change.action === "marketplace_remove";
		const marketplace = isMarketplace ? change.target : change.target.split("@")[1];
		const { catalog, registry } = await this.snapshot(signal, marketplace);
		const selected = isMarketplace ? catalog.marketplaces.find((item) => item.name === change.target)
			: catalog.plugins.find((item) => item.id === change.target);
		if (!selected || selected.revision !== change.revision) {
			return { ok: false, action: change.action, message: "Plugin sources or configuration changed. Refresh the list and review the selection again.", issues: ["plugin_catalog_changed"] };
		}
		let request: PluginPackageRequest;
		if (isMarketplace) request = { action: "marketplace", operation: change.action === "marketplace_upgrade" ? "upgrade" : "remove", target: change.target };
		else if (change.action === "install") request = { action: "add", source: change.target };
		else if (change.action === "enable" || change.action === "disable" || change.action === "remove" || change.action === "update") request = { action: change.action, pluginId: change.target };
		else throw new PluginPackageError("plugin_source_invalid");
		const installed = registry.plugins.find((item) => item.id === change.target);
		const market = registry.marketplaces.find((item) => item.name === marketplace);
		return manager.execute(request, signal, {
			...(installed ? { pluginCacheKey: installed.cacheKey } : {}),
			...(market ? { marketplaceCacheKey: market.cacheKey } : {}),
		});
	}

	private async snapshot(signal: AbortSignal, marketplace?: string): Promise<CatalogSnapshot> {
		signal.throwIfAborted();
		const registry = await readPluginPackageRegistry(this.options.homeDir);
		const discovery = await discoverPlugins({ ...this.options, maxPlugins: 1_024 });
		const candidates = new Map(discovery.selected.map((item) => [item.pluginId, item]));
		const rows = new Map<string, PluginCatalogEntry>();
		const issues = discovery.diagnostics.map((item) => item.errorClass);
		const marketplaces: PluginCatalog["marketplaces"] = [];
		let truncated = false;
		for (const candidate of discovery.selected) {
			signal.throwIfAborted();
			if (!isPluginId(candidate.pluginId)) continue;
			const installed = registry.plugins.find((item) => item.id === candidate.pluginId);
			if (marketplace && installed?.marketplace !== marketplace) continue;
			if (rows.size >= MAX_CATALOG_ENTRIES) { truncated = true; break; }
			const data = candidateMetadata(candidate);
			rows.set(candidate.pluginId, { ...data, id: candidate.pluginId,
				revision: revision([candidate, installed, this.options.includeRepository !== false]),
				source: installed ? sourceLabel(installed.source) : candidate.source === "repo" ? "Workspace directory" : "User directory",
				installed: true, managed: Boolean(installed), enabled: candidate.enabled,
				...(installed?.marketplace ? { marketplace: installed.marketplace } : {}),
			});
		}
		// Retain repair/removal access even when discovery hits its own runtime limit.
		for (const installed of registry.plugins) {
			if (rows.has(installed.id) || marketplace && installed.marketplace !== marketplace) continue;
			if (rows.size >= MAX_CATALOG_ENTRIES) { truncated = true; break; }
			rows.set(installed.id, { id: installed.id, revision: revision(installed), name: installed.id, description: "",
				source: sourceLabel(installed.source), installed: true, enabled: discovery.enablement.isEnabled(installed.id), managed: true,
				status: "invalid", issues: ["plugin_metadata_unavailable"], ...(installed.marketplace ? { marketplace: installed.marketplace } : {}) });
		}
		for (const market of registry.marketplaces) {
			signal.throwIfAborted();
			const item: PluginCatalog["marketplaces"][number] = { name: market.name, revision: revision(market), source: sourceLabel(market.source), issues: [] };
			marketplaces.push(item);
			if (marketplace && marketplace !== market.name) continue;
			try {
				const manifest = await loadMarketplace(pluginCacheRoot(this.options.homeDir, market.cacheKey));
				for (const entry of manifest.entries) {
					signal.throwIfAborted();
					const id = `${entry.name}@${market.name}`;
					const installed = rows.get(id);
					if (installed) {
						// Updating must remain bound to the reviewed marketplace snapshot, too.
						rows.set(id, { ...installed, revision: revision([installed.revision, market, entry]) });
						continue;
					}
					if (rows.size >= MAX_CATALOG_ENTRIES) { truncated = true; continue; }
					let metadata: Metadata = { name: entry.displayName ?? entry.name, description: entry.description ?? "", status: entry.available ? "available" : "unavailable", issues: [] };
					if (entry.source.kind === "local") {
						try {
							const candidate = await localCandidate(entry.source.path, entry.name);
							const local = candidateMetadata(candidate);
							candidates.set(id, candidate);
							metadata = { ...local, name: entry.displayName ?? local.name, description: entry.description ?? local.description, status: metadata.status };
						} catch (error) { metadata = { ...metadata, status: "unavailable", issues: [packageIssue(error)] }; }
					}
					rows.set(id, { ...metadata, id, revision: revision([market, entry, metadata]), marketplace: market.name,
						source: entry.source.kind === "local" ? `Local package in ${market.name}` : sourceLabel(entry.source),
						installed: false, enabled: false, managed: false });
				}
			} catch (error) {
				if (signal.aborted) throw error;
				item.issues.push(packageIssue(error));
			}
		}
		signal.throwIfAborted();
		const catalog: PluginCatalog = { plugins: [], marketplaces, issues: [...new Set(issues)].slice(0, 64), truncated,
			repository_enabled: this.options.includeRepository !== false };
		let bytes = Buffer.byteLength(JSON.stringify(catalog));
		for (const entry of [...rows.values()].sort((a, b) => a.id.localeCompare(b.id))) {
			bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
			if (bytes > 6 * 1024 * 1024) { catalog.truncated = true; break; }
			catalog.plugins.push(entry);
		}
		return { registry, candidates, catalog };
	}
}

function candidateMetadata(candidate: PluginCandidate): Metadata {
	if (candidate.kind === "invalid" || candidate.kind === "migration_required") return { name: safeText(candidate.pluginId, 128), description: "",
		status: candidate.kind, issues: [candidate.kind === "invalid" ? candidate.diagnostic.errorClass : "plugin_migration_required"] };
	const manifest = candidate.manifest;
	const names = pluginDeclarations(candidate);
	const count = (values: readonly string[]): number => Math.min(values.length, 65_536);
	const capabilities: PluginCapabilitySummary = { skills: count(names.skills), mcpServers: count(names.mcpServers),
		hooks: count(names.hooks), tools: count(names.tools), commands: count(names.commands) };
	return { name: safeText(candidate.kind === "bundle" ? candidate.manifest.displayName : manifest.name, 128),
		description: safeText(manifest.description ?? "", 512), status: "installed", capabilities,
		...(manifest.version ? { version: safeText(manifest.version, 64) } : {}),
		issues: [...(candidate.kind === "bundle" ? candidate.manifest.issues : []), ...(candidate.duplicate ? ["duplicate_plugin_id"] : [])].slice(0, 64) };
}

async function localCandidate(root: string, name: string): Promise<PluginCandidate> {
	if (await findBundleManifest(root)) {
		const manifest = await loadPluginBundle(root, name);
		if (manifest.name !== name) throw new PluginPackageError("plugin_name_mismatch");
		return { kind: "bundle", pluginId: name, source: "user", enabled: false, duplicate: false, manifest };
	}
	const loaded = await loadPluginManifest({ pluginRoot: root, source: "user" });
	if (loaded.kind !== "loaded") throw new PluginPackageError(loaded.diagnostic.errorClass);
	if (loaded.manifest.id !== name) throw new PluginPackageError("plugin_name_mismatch");
	return { kind: "plugin", pluginId: name, source: "user", enabled: false, duplicate: false, manifest: loaded.manifest };
}

function revision(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function safeText(value: string, limit: number): string { return value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, limit); }
function sourceLabel(source: PluginPackageSource): string {
	if (source.kind === "local") return safeText(source.path, 512);
	try {
		const url = new URL(source.url);
		return safeText(`${url.protocol}//${url.host}${url.pathname}${source.ref ? ` (${source.ref})` : ""}`, 512);
	} catch { return /^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/u.test(source.url) ? safeText(source.url, 512) : "Git repository"; }
}
export function packageIssue(error: unknown): string { return error instanceof PluginPackageError ? safeText(error.code, 128) : "plugin_package_operation_failed"; }
