import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import {
	delimiter as posixDelimiter,
	dirname,
	join,
	normalize as posixNormalize,
	resolve,
	win32,
} from "node:path";
import { fileURLToPath } from "node:url";
import { RIPGREP_TARGETS, ripgrepOutputPath, ripgrepPlatformKey } from "./ripgrep-targets.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

export interface ResolveRipgrepOptions {
	readonly platform?: NodeJS.Platform;
	readonly architecture?: string;
	readonly homeDir?: string;
	readonly packageRoot?: string;
	readonly pathValue?: string;
	readonly platformPackageRoot?: string | null;
}

export interface RipgrepPathResult {
	readonly path: string;
	readonly directory?: string;
	readonly executable?: string;
}

export interface InitializeRipgrepEnvironmentOptions
	extends Omit<ResolveRipgrepOptions, "pathValue"> {
	readonly env?: NodeJS.ProcessEnv;
}

export function initializeRipgrepEnvironment(
	options: InitializeRipgrepEnvironmentOptions = {},
): RipgrepPathResult {
	const platform = options.platform ?? process.platform;
	const { env = process.env, ...resolveOptions } = options;
	const pathKey = environmentPathKey(env, platform);
	const result = prependRipgrepToPath({
		...resolveOptions,
		platform,
		pathValue: env[pathKey],
	});
	env[pathKey] = result.path;
	if (result.directory) {
		env.MYCLI_RIPGREP_PATH_DIR = result.directory;
	} else {
		delete env.MYCLI_RIPGREP_PATH_DIR;
	}
	return result;
}

export function prependRipgrepToPath(options: ResolveRipgrepOptions = {}): RipgrepPathResult {
	const platform = options.platform ?? process.platform;
	const existing = options.pathValue ?? defaultPath(platform);
	const executable = resolveRipgrep({ ...options, platform, pathValue: existing });
	if (!executable) return Object.freeze({ path: existing });
	const directory = dirname(executable);
	const delimiter = platform === "win32" ? win32.delimiter : posixDelimiter;
	const parts = existing.split(delimiter).filter(Boolean);
	const normalizedDirectory = comparablePath(directory, platform);
	const filtered = parts.filter((part) => comparablePath(part, platform) !== normalizedDirectory);
	return Object.freeze({
		path: [directory, ...filtered].join(delimiter),
		directory,
		executable,
	});
}

export function resolveRipgrep(options: ResolveRipgrepOptions = {}): string | undefined {
	const platform = options.platform ?? process.platform;
	const target = ripgrepPlatformKey(platform, options.architecture ?? process.arch);
	const homeDir = options.homeDir ?? homedir();
	const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
	const platformPackageRoot = options.platformPackageRoot === undefined
		? resolvePlatformPackageRoot(target)
		: options.platformPackageRoot;
	const vendorCandidates = [
		...(platformPackageRoot
			? [ripgrepOutputPath(join(platformPackageRoot, "vendor"), target)]
			: []),
		ripgrepOutputPath(join(packageRoot, "native", "ripgrep"), target),
		ripgrepOutputPath(join(homeDir, ".mycli", "vendor", "ripgrep"), target),
	];
	for (const candidate of vendorCandidates) {
		if (isExecutable(candidate, platform)) return candidate;
	}
	return findOnPath(options.pathValue ?? defaultPath(platform), platform);
}

function resolvePlatformPackageRoot(target: keyof typeof RIPGREP_TARGETS): string | undefined {
	try {
		const manifest = require.resolve(`${RIPGREP_TARGETS[target].npmPackage}/package.json`);
		return dirname(manifest);
	} catch {
		return undefined;
	}
}

function environmentPathKey(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
	if (platform !== "win32") return "PATH";
	return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

function findOnPath(pathValue: string, platform: NodeJS.Platform): string | undefined {
	const delimiter = platform === "win32" ? win32.delimiter : posixDelimiter;
	const executable = platform === "win32" ? "rg.exe" : "rg";
	for (const directory of pathValue.split(delimiter).filter(Boolean)) {
		const candidate = platform === "win32"
			? win32.join(directory, executable)
			: join(directory, executable);
		if (isExecutable(candidate, platform)) return candidate;
	}
	return undefined;
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
	try {
		accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function comparablePath(path: string, platform: NodeJS.Platform): string {
	return platform === "win32" ? win32.normalize(path).toLowerCase() : posixNormalize(path);
}

function defaultPath(platform: NodeJS.Platform): string {
	return platform === "win32"
		? ".;C:\\Windows\\System32;C:\\Windows"
		: "/bin:/usr/bin";
}
