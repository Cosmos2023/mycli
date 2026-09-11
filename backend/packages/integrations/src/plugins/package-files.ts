import { copyFile, chmod, lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

export class PluginPackageError extends Error {
	constructor(readonly code: string) { super(code); this.name = "PluginPackageError"; }
}

export function isPluginId(value: unknown): value is string {
	return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}(?:@[a-z0-9][a-z0-9._-]{0,63})?$/u.test(value);
}

export function pluginRouteNamespace(id: string): string {
	return id.includes("@") ? `${id.split("@")[0]!.slice(0, 24)}-${createHash("sha256").update(id).digest("hex").slice(0, 16)}` : id;
}

export function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function optionalFile(path: string): Promise<boolean> {
	try { const metadata = await lstat(path); return metadata.isFile() || metadata.isSymbolicLink(); }
	catch (error) { if (isMissing(error)) return false; throw new PluginPackageError("plugin_file_unavailable"); }
}

export function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function containedPath(root: string, path: string): Promise<string> {
	const base = await realpath(root);
	const target = await realpath(resolve(base, path));
	const suffix = relative(base, target);
	if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) throw new PluginPackageError("plugin_path_escape");
	return target;
}

export async function readPackageJson(path: string): Promise<Readonly<Record<string, unknown>>> {
	const metadata = await lstat(path);
	if (!metadata.isFile() || metadata.size > 1_048_576) throw new PluginPackageError("plugin_json_invalid");
	try {
		const bytes = await readFile(path);
		if (bytes.byteLength > 1_048_576) throw new PluginPackageError("plugin_json_invalid");
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		if (!isObject(value)) throw new PluginPackageError("plugin_json_invalid");
		return value;
	} catch { throw new PluginPackageError("plugin_json_invalid"); }
}

export async function copyPluginPackage(source: string, target: string, signal: AbortSignal): Promise<void> {
	const root = await realpath(source);
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	const targetRelative = relative(root, join(await realpath(dirname(target)), basename(target)));
	if (!targetRelative || !isAbsolute(targetRelative) && targetRelative !== ".." && !targetRelative.startsWith(`..${sep}`)) {
		throw new PluginPackageError("plugin_destination_inside_source");
	}
	let bytes = 0;
	let files = 0;
	const walk = async (from: string, to: string, ancestors: ReadonlySet<string>): Promise<void> => {
		signal.throwIfAborted();
		const resolved = await containedPath(root, from);
		const metadata = await lstat(resolved);
		files += 1;
		if (files > 10_000) throw new PluginPackageError("plugin_package_too_large");
		if (metadata.isDirectory()) {
			if (ancestors.has(resolved)) throw new PluginPackageError("plugin_path_cycle");
			await mkdir(to, { recursive: true, mode: 0o700 });
			const next = new Set([...ancestors, resolved]);
			for (const name of (await readdir(resolved)).sort()) {
				if (name === ".git") continue;
				await walk(join(resolved, name), join(to, name), next);
			}
		} else if (metadata.isFile()) {
			bytes += metadata.size;
			if (bytes > 128 * 1024 * 1024) throw new PluginPackageError("plugin_package_too_large");
			await copyFile(resolved, to);
			await chmod(to, metadata.mode & 0o700 | 0o600);
		} else throw new PluginPackageError("plugin_file_type_unsupported");
	};
	await walk(root, target, new Set());
}
