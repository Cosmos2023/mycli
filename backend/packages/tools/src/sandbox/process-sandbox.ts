import { ProcessSandboxError } from "./process-sandbox-error.ts";
export { ProcessSandboxError } from "./process-sandbox-error.ts";
import { hasDeniedReads } from "../policy/denied-read-policy.ts";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
	hasUnrestrictedFilesystem,
	hasUnrestrictedNetwork,
	type SandboxProfile,
} from "../policy/execution-policy.ts";
import { isOutside } from "../path-containment.ts";
import {
	LINUX_BUBBLEWRAP_EXECUTABLES,
	linuxBubblewrapLaunch,
} from "./linux-bubblewrap.ts";
import {
	MACOS_SEATBELT_EXECUTABLE,
	macosSeatbeltLaunch,
} from "./macos-seatbelt.ts";
import { windowsRestrictedTokenLaunch } from "./windows-restricted-token.ts";
import {
	packagedWindowsSandboxHelper,
	sandboxExecutableExists,
} from "./sandbox-readiness.ts";

const PROTECTED_METADATA = [
	[".git", "PROTECTED_ROOT_GIT"],
	[".agents", "PROTECTED_ROOT_AGENTS"],
	[".codex", "PROTECTED_ROOT_CODEX"],
] as const;

export type ProcessIsolation =
	| "host_subprocess"
	| "macos_seatbelt"
	| "linux_bubblewrap"
	| "windows_restricted_token"
	| "windows_native";

export interface SandboxedProcessLaunch {
	readonly executable: string;
	readonly args: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
	readonly isolation: ProcessIsolation;
}

export interface ProcessSandboxProbes {
	readonly platform?: NodeJS.Platform;
	readonly isExecutable?: (path: string) => boolean;
	readonly pathExists?: (path: string) => boolean;
	readonly isSymbolicLink?: (path: string) => boolean;
	readonly windowsHelperPath?: string;
}

export interface ProcessNetworkProxy {
	readonly port: number;
}

export function prepareSandboxedProcess(
	argv: readonly string[],
	profile: SandboxProfile,
	probes: ProcessSandboxProbes = {},
	networkProxy?: ProcessNetworkProxy,
): SandboxedProcessLaunch {
	validateArgv(argv);
	const platform = probes.platform ?? process.platform;
	if (platform !== "win32" && ((profile.readOnlyRoots?.length ?? 0) > 0
		|| profile.allowLocalBinding !== undefined || profile.writableTemp !== undefined)) {
		throw new ProcessSandboxError("sandbox_unavailable", "This platform cannot enforce the requested Windows policy features.");
	}
	if (networkProxy && ((platform !== "darwin" && platform !== "win32") || profile.network !== "enabled"
		|| profile.networkDomains === undefined || profile.networkDomains.length === 0
		|| !Number.isSafeInteger(networkProxy.port) || networkProxy.port < 1 || networkProxy.port > 65_535)) {
		throw new ProcessSandboxError("network_proxy_unavailable", "The process network proxy cannot enforce this policy.");
	}
	if (hasDeniedReads(profile) && platform !== "win32") {
		throw new ProcessSandboxError("sandbox_unavailable", "Denied-read rules require the Windows restricted filesystem sandbox.");
	}
	if (profile.mode === "danger-full-access" && hasUnrestrictedNetwork(profile)
		&& !hasDeniedReads(profile) && !profile.readOnlyRoots?.length && profile.readableRoots === undefined) {
		return hostLaunch(argv);
	}
	const resolvedProfile = resolveProfile(profile);
	const isExecutable = probes.isExecutable ?? sandboxExecutableExists;
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
		), networkProxy);
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
		const helper = probes.windowsHelperPath ?? packagedWindowsSandboxHelper();
		if (!isExecutable(helper)) throw unavailable();
		return windowsRestrictedTokenLaunch(helper, argv, resolvedProfile, networkProxy);
	}
	throw unavailable();
}

function resolveProfile(profile: SandboxProfile): SandboxProfile {
	// Match fs.promises.realpath used by Shell cwd resolution. On Windows the
	// JS fallback can retain 8.3 names while the native API expands them.
	const workspaceRoot = realpathSync.native(profile.workspaceRoot);
	const cwd = realpathSync.native(profile.cwd);
	if (!hasUnrestrictedFilesystem(profile) && isOutside(workspaceRoot, cwd)) {
		throw new ProcessSandboxError("sandbox_unavailable", "Sandbox cwd is outside the workspace.");
	}
	return Object.freeze({
		...profile,
		workspaceRoot,
		cwd,
		writableRoots: Object.freeze(profile.writableRoots.map((root) => realpathSync.native(root))),
		...(profile.readableRoots === undefined ? {} : { readableRoots: Object.freeze(profile.readableRoots.map((root) => realpathSync.native(root))) }),
		...(profile.readOnlyRoots === undefined ? {} : { readOnlyRoots: Object.freeze(profile.readOnlyRoots.map((root) => realpathSync.native(root))) }),
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

function validateArgv(argv: readonly string[]): void {
	if (argv.length === 0 || !argv[0]?.trim()) {
		throw new TypeError("process argv must contain a non-empty executable");
	}
}

function symbolicLinkExists(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function unavailable(): ProcessSandboxError {
	return new ProcessSandboxError("sandbox_unavailable");
}
