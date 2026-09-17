import { isAbsolute, join, resolve } from "node:path";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { containedPath, copyPluginPackage, isObject, isPluginId, optionalFile, PluginPackageError, readPackageJson } from "./package-files.ts";
import type { PluginPackageSource } from "./package-registry.ts";
import { runPackageGit } from "./package-git.ts";

export interface PluginMarketplaceEntry {
	readonly name: string;
	readonly displayName?: string;
	readonly description?: string;
	readonly source: PluginPackageSource;
	readonly available: boolean;
}

export interface PluginMarketplaceManifest {
	readonly name: string;
	readonly entries: readonly PluginMarketplaceEntry[];
}

export async function resolvePackageSource(value: string, workspaceRoot: string, homeDir: string, ref?: string): Promise<PluginPackageSource> {
	if (!value.trim() || value.length > 4_096 || /\p{Cc}/u.test(value)) throw new PluginPackageError("plugin_source_invalid");
	const local = value.startsWith("~/") ? join(homeDir, value.slice(2)) : resolve(workspaceRoot, value);
	let localExists = false;
	try { localExists = (await lstat(local)).isDirectory(); } catch { /* Remote sources need no local entry. */ }
	if (localExists || isAbsolute(value) || value.startsWith(".")) {
		if (ref !== undefined) throw new PluginPackageError("plugin_ref_requires_git");
		if (!localExists) throw new PluginPackageError("plugin_source_unavailable");
		return { kind: "local", path: await realpath(local) };
	}
	const hash = value.lastIndexOf("#");
	const base = hash >= 0 ? value.slice(0, hash) : value;
	const selectedRef = ref ?? (hash >= 0 ? value.slice(hash + 1) : undefined);
	const url = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(base) ? `https://github.com/${base}.git` : base;
	validateGitSource(url, selectedRef);
	return { kind: "git", url, ...(selectedRef ? { ref: selectedRef } : {}) };
}

export async function stagePluginSource(source: PluginPackageSource, destination: string, signal: AbortSignal): Promise<void> {
	if (source.kind === "local") return copyPluginPackage(source.path, destination, signal);
	validateGitSource(source.url, source.ref);
	const checkout = `${destination}.git-checkout`;
	const controlRoot = `${destination}.git-control`;
	const git = (args: readonly string[]): Promise<string> => runPackageGit(args, controlRoot, signal);
	try {
		await mkdir(controlRoot, { recursive: true, mode: 0o700 });
		await git(["clone", "--depth=1", ...(source.ref ? ["--branch", source.ref] : []), "--", source.url, checkout]);
		if (source.sha) {
			if (!/^[a-f0-9]{40}$/iu.test(source.sha)) throw new PluginPackageError("plugin_revision_invalid");
			await git(["-C", checkout, "fetch", "--depth=1", "origin", source.sha]);
			await git(["-C", checkout, "checkout", "--detach", "FETCH_HEAD"]);
			if ((await git(["-C", checkout, "rev-parse", "HEAD"])).toLowerCase() !== source.sha.toLowerCase()) throw new PluginPackageError("plugin_revision_mismatch");
		}
		if (source.path && (isAbsolute(source.path) || source.path.split(/[\\/]/u).includes(".."))) throw new PluginPackageError("plugin_path_invalid");
		await copyPluginPackage(await containedPath(checkout, source.path ?? "."), destination, signal);
	} finally {
		await rm(checkout, { recursive: true, force: true });
		await rm(controlRoot, { recursive: true, force: true });
	}
}

export async function loadMarketplace(root: string): Promise<PluginMarketplaceManifest> {
	let path: string | undefined;
	for (const candidate of [".agents/plugins/marketplace.json", ".agents/plugins/api_marketplace.json", ".claude-plugin/marketplace.json"]) {
		if (await optionalFile(join(root, candidate))) { path = await containedPath(root, candidate); break; }
	}
	if (!path) throw new PluginPackageError("plugin_marketplace_missing");
	const value = await readPackageJson(path);
	if (!isPluginId(value.name) || value.name.includes("@") || !Array.isArray(value.plugins) || value.plugins.length > 1_024) throw new PluginPackageError("plugin_marketplace_invalid");
	const entries: PluginMarketplaceEntry[] = [];
	for (const item of value.plugins) {
		if (!isObject(item) || !isPluginId(item.name) || item.name.includes("@")) throw new PluginPackageError("plugin_marketplace_invalid");
		const raw = typeof item.source === "string" ? { source: "local", path: item.source } : item.source;
		if (!isObject(raw)) throw new PluginPackageError("plugin_marketplace_source_invalid");
		let source: PluginPackageSource;
		if (raw.source === "local" && typeof raw.path === "string" && raw.path.startsWith("./") && !raw.path.split(/[\\/]/u).includes("..")) {
			source = { kind: "local", path: await containedPath(root, raw.path) };
		} else if ((raw.source === "url" || raw.source === "git-subdir") && typeof raw.url === "string") {
			if (raw.source === "git-subdir" && optionalString(raw.path) === undefined) throw new PluginPackageError("plugin_marketplace_source_invalid");
			const ref = optionalString(raw.ref);
			validateGitSource(raw.url, ref);
			source = { kind: "git", url: raw.url, ...(ref ? { ref } : {}),
				...(optionalString(raw.path) ? { path: optionalString(raw.path) } : {}), ...(optionalString(raw.sha) ? { sha: optionalString(raw.sha) } : {}) };
		} else throw new PluginPackageError("plugin_marketplace_source_invalid");
		const policy = isObject(item.policy) ? item.policy : {};
		const ui = isObject(item.interface) ? item.interface : {};
		const displayName = displayText(ui.displayName ?? item.displayName, 128);
		const description = displayText(item.description ?? ui.shortDescription, 512);
		entries.push({ name: item.name, source, available: policy.installation !== "NOT_AVAILABLE",
			...(displayName ? { displayName } : {}), ...(description ? { description } : {}) });
	}
	if (new Set(entries.map((entry) => entry.name)).size !== entries.length) throw new PluginPackageError("plugin_marketplace_duplicate");
	return { name: value.name, entries: Object.freeze(entries) };
}

function displayText(value: unknown, limit: number): string | undefined {
	return typeof value === "string" ? value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, limit) : undefined;
}

function optionalString(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value || value.length > 2_048 || /\p{Cc}/u.test(value)) throw new PluginPackageError("plugin_source_invalid");
	return value;
}

function validateGitSource(url: string, ref?: string): void {
	if (!url || url.length > 2_048 || /[\p{Cc}\s]/u.test(url)) throw new PluginPackageError("plugin_git_source_invalid");
	if (ref !== undefined && (!ref || ref.length > 2_048 || ref.startsWith("-") || /[\p{Cc}\s]/u.test(ref))) throw new PluginPackageError("plugin_revision_invalid");
	if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/u.test(url)) return;
	try {
		const parsed = new URL(url);
		if (!["https:", "ssh:"].includes(parsed.protocol) || parsed.password || parsed.username && !(parsed.protocol === "ssh:" && parsed.username === "git")
			|| parsed.search || parsed.hash) throw new Error("invalid");
	} catch { throw new PluginPackageError("plugin_git_source_invalid"); }
}
