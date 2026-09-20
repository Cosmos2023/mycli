import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxProfile } from "@mycli/tools";

interface RuntimePackage {
	readonly name: string;
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly optionalDependencies?: Readonly<Record<string, string>>;
}

// These are host runtime dependencies, never dependencies declared by a plugin.
export function pluginWorkerSandboxProfile(profile: SandboxProfile, workerPath: string,
	source: boolean, platform: NodeJS.Platform = process.platform): SandboxProfile {
	if (platform !== "win32" || profile.mode === "danger-full-access") return profile;
	const roots = new Set<string>([
		realpathSync.native(workerPath),
		realpathSync.native(fileURLToPath(new URL("../../package.json", import.meta.url))),
	]);
	const visited = new Set<string>();
	const containers = new Set<string>();
	addModuleContainer(createRequire(import.meta.url), "@mycli/contracts", containers);
	visitPackage(packageDirectory(fileURLToPath(import.meta.resolve("@mycli/contracts"))), roots, visited, containers);
	if (source) {
		addModuleContainer(createRequire(import.meta.url), "tsx", containers);
		visitPackage(packageDirectory(fileURLToPath(import.meta.resolve("tsx"))), roots, visited, containers);
	}
	// Node checks node_modules itself before opening an otherwise readable package.
	// Container trees may contain workspace links, so keep them outside write grants
	// instead of recursively scanning them as protected trees.
	if ([...containers].some((root) => profile.writableRoots.some((write) => {
		const canonical = realpathSync.native(write);
		return within(root, canonical) || within(canonical, root);
	}))) throw new Error("plugin_runtime_write_overlap");
	const reads = [...roots, ...containers];
	// Explicit read roots are a managed upper bound. Missing runtime access fails closed.
	if (profile.readableRoots !== undefined) {
		const allowed = [profile.workspaceRoot, ...profile.readableRoots].map((root) => realpathSync.native(root));
		if (reads.some((root) => !allowed.some((parent) => within(parent, root)))) {
			throw new Error("plugin_runtime_read_denied");
		}
	}
	return Object.freeze({ ...profile,
		readableRoots: Object.freeze([...new Set([...(profile.readableRoots ?? []), ...reads])]),
		readOnlyRoots: Object.freeze([...new Set([...(profile.readOnlyRoots ?? []), ...roots])]),
	});
}

function packageDirectory(entry: string): string {
	let directory = dirname(entry);
	for (let depth = 0; depth < 64; depth += 1) {
		try {
			readPackage(directory);
			return realpathSync.native(directory);
		} catch (error) {
			if (!hasCode(error, "ENOENT")) throw error;
		}
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error("plugin_runtime_package_missing");
}

function visitPackage(directory: string, roots: Set<string>, visited: Set<string>, containers: Set<string>): void {
	const key = directory.toLowerCase();
	if (visited.has(key)) return;
	if (visited.size >= 128) throw new Error("plugin_runtime_dependency_limit");
	visited.add(key);
	roots.add(directory);
	const manifest = readPackage(directory);
	const require = createRequire(join(directory, "package.json"));
	const optional = manifest.optionalDependencies ?? {};
	for (const name of new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(optional)])) {
		let entry: string;
		try {
			entry = require.resolve(`${name}/package.json`);
		} catch (error) {
			if (hasCode(error, "ERR_PACKAGE_PATH_NOT_EXPORTED")) entry = require.resolve(name);
			else if (name in optional && hasCode(error, "MODULE_NOT_FOUND")) continue;
			else throw error;
		}
		addModuleContainer(require, name, containers);
		visitPackage(packageDirectory(entry), roots, visited, containers);
	}
}

function addModuleContainer(require: NodeJS.Require, name: string, containers: Set<string>): void {
	const container = require.resolve.paths(name)?.find((path) => existsSync(join(path, name, "package.json")));
	if (!container) throw new Error("plugin_runtime_package_missing");
	containers.add(realpathSync.native(container));
}

function readPackage(directory: string): RuntimePackage {
	const value: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	if (!isRecord(value) || typeof value.name !== "string"
		|| !dependencies(value.dependencies) || !dependencies(value.optionalDependencies)) {
		throw new Error("plugin_runtime_package_invalid");
	}
	return { name: value.name, dependencies: value.dependencies, optionalDependencies: value.optionalDependencies };
}

function dependencies(value: unknown): value is Readonly<Record<string, string>> | undefined {
	return value === undefined || (isRecord(value) && Object.values(value).every((version) => typeof version === "string"));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function within(root: string, path: string): boolean {
	const suffix = relative(root, path);
	return suffix !== ".." && !suffix.startsWith(`..\\`) && !suffix.startsWith("../") && !isAbsolute(suffix);
}
