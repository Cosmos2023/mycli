import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	hasUnrestrictedFilesystem,
	hasUnrestrictedNetwork,
	type SandboxProfile,
} from "./execution-policy.ts";
import {
	LINUX_BUBBLEWRAP_EXECUTABLES,
	linuxBubblewrapLaunch,
} from "./sandbox/linux-bubblewrap.ts";
import {
	MACOS_SEATBELT_EXECUTABLE,
	macosSeatbeltLaunch,
} from "./sandbox/macos-seatbelt.ts";
import { windowsRestrictedTokenLaunch } from "./sandbox/windows-restricted-token.ts";

const PROTECTED_METADATA = [
	[".git", "PROTECTED_ROOT_GIT"],
	[".agents", "PROTECTED_ROOT_AGENTS"],
	[".codex", "PROTECTED_ROOT_CODEX"],
] as const;

export type ProcessIsolation =
	| "host_subprocess"
	| "macos_seatbelt"
	| "linux_bubblewrap"
	| "windows_restricted_token";

export interface SandboxedProcessLaunch {
	readonly executable: string;
	readonly args: readonly string[];
	readonly isolation: ProcessIsolation;
}

export interface ProcessSandboxProbes {
	readonly platform?: NodeJS.Platform;
	readonly isExecutable?: (path: string) => boolean;
	readonly pathExists?: (path: string) => boolean;
	readonly isSymbolicLink?: (path: string) => boolean;
	readonly windowsHelperPath?: string;
}

export class ProcessSandboxError extends Error {
	constructor(
		readonly kind: "sandbox_unavailable",
		message = "Required process sandbox is unavailable.",
	) {
		super(message);
		this.name = "ProcessSandboxError";
	}
}

export function prepareSandboxedProcess(
	argv: readonly string[],
	profile: SandboxProfile,
	probes: ProcessSandboxProbes = {},
): SandboxedProcessLaunch {
	validateArgv(argv);
	if (profile.mode === "danger-full-access" && hasUnrestrictedNetwork(profile)) {
		return hostLaunch(argv);
	}
	const resolvedProfile = resolveProfile(profile);
	const platform = probes.platform ?? process.platform;
	const isExecutable = probes.isExecutable ?? executableExists;
	const pathExists = probes.pathExists ?? existsSync;
	const isSymbolicLink = probes.isSymbolicLink ?? symbolicLinkExists;
	if (platform === "darwin") {
		if (!isExecutable(MACOS_SEATBELT_EXECUTABLE)) throw unavailable();
		const protectedMetadata = hasUnrestrictedFilesystem(resolvedProfile) ? [] : protectedMetadataPaths(
			resolvedProfile,
			pathExists,
			isSymbolicLink,
			true,
		);
		return macosSeatbeltLaunch(argv, resolvedProfile, Object.fromEntries(
			protectedMetadata.map(({ key, path }) => [key, path]),
		));
	}
	if (platform === "linux") {
		const executable = LINUX_BUBBLEWRAP_EXECUTABLES.find(isExecutable);
		if (!executable) throw unavailable();
		const protectedMetadata = hasUnrestrictedFilesystem(resolvedProfile) ? [] : protectedMetadataPaths(
			resolvedProfile,
			pathExists,
			isSymbolicLink,
			false,
		);
		return linuxBubblewrapLaunch(
			executable,
			argv,
			resolvedProfile,
			protectedMetadata.map(({ path }) => path),
		);
	}
	if (platform === "win32") {
		const helper = probes.windowsHelperPath ?? packagedWindowsHelper();
		if (!isExecutable(helper)) throw unavailable();
		return windowsRestrictedTokenLaunch(helper, argv, resolvedProfile);
	}
	throw unavailable();
}

function resolveProfile(profile: SandboxProfile): SandboxProfile {
	const workspaceRoot = realpathSync(profile.workspaceRoot);
	const cwd = realpathSync(profile.cwd);
	if (!hasUnrestrictedFilesystem(profile) && isOutside(workspaceRoot, cwd)) {
		throw new ProcessSandboxError("sandbox_unavailable", "Sandbox cwd is outside the workspace.");
	}
	return Object.freeze({
		...profile,
		workspaceRoot,
		cwd,
		writableRoots: Object.freeze(profile.writableRoots.map((root) => realpathSync(root))),
	});
}

function protectedMetadataPaths(
	profile: SandboxProfile,
	pathExists: (path: string) => boolean,
	isSymbolicLink: (path: string) => boolean,
	includeMissing: boolean,
): readonly { readonly key: string; readonly path: string }[] {
	const protectedRoots: { key: string; path: string }[] = [];
	for (const root of profile.writableRoots) {
		for (const [name, key] of PROTECTED_METADATA) {
			const path = join(root, name);
			if (isSymbolicLink(path)) {
				throw new ProcessSandboxError(
					"sandbox_unavailable",
					"Sandbox cannot protect repository metadata through a symbolic link.",
				);
			}
			if (!includeMissing && !pathExists(path)) continue;
			protectedRoots.push(Object.freeze({ key, path }));
		}
	}
	return Object.freeze(protectedRoots);
}

function hostLaunch(argv: readonly string[]): SandboxedProcessLaunch {
	return Object.freeze({
		executable: argv[0]!,
		args: Object.freeze(argv.slice(1)),
		isolation: "host_subprocess",
	});
}

function packagedWindowsHelper(): string {
	return join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"native",
		"windows",
		"mycli-windows-sandbox.exe",
	);
}

function validateArgv(argv: readonly string[]): void {
	if (argv.length === 0 || !argv[0]?.trim()) {
		throw new TypeError("process argv must contain a non-empty executable");
	}
}

function executableExists(path: string): boolean {
	try {
		return statSync(path).isFile() && (process.platform === "win32" || (statSync(path).mode & 0o111) !== 0);
	} catch {
		return false;
	}
}

function symbolicLinkExists(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function isOutside(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
		|| isAbsolute(fromRoot);
}

function unavailable(): ProcessSandboxError {
	return new ProcessSandboxError("sandbox_unavailable");
}
