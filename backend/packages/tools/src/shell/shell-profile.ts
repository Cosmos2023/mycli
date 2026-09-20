import { existsSync } from "node:fs";
import { win32 } from "node:path";

export type ShellProfileName = "zsh" | "bash" | "sh" | "powershell" | "cmd" | "posix";

export type ShellDialect =
	| "posix-sh"
	| "powershell-7"
	| "windows-powershell-5.1"
	| "cmd";

export interface ShellProfile {
	readonly kind: "posix" | "powershell" | "cmd";
	readonly name: ShellProfileName;
	/** Concrete command language, including the PowerShell generation. */
	readonly dialect: ShellDialect;
	readonly executable: string;
	execArgv(command: string): readonly string[];
}

export interface ResolveShellProfileOptions {
	readonly platform?: NodeJS.Platform;
	readonly env?: Readonly<NodeJS.ProcessEnv>;
	readonly shellPath?: string;
	/** Test seam for Windows executable discovery. */
	readonly findExecutable?: (
		name: string,
		env: Readonly<NodeJS.ProcessEnv>,
		pathExists: (candidate: string) => boolean,
	) => string | undefined;
	/** Test seam for validating a configured absolute shell path. */
	readonly pathExists?: (candidate: string) => boolean;
}

/** Environment override documented in docs/windows.md. */
export const SHELL_PATH_ENV_KEY = "MYCLI_SHELL_PATH";

const WINDOWS_POWERSHELL_NAMES = ["pwsh.exe", "pwsh", "powershell.exe", "powershell"] as const;

const WINDOWS_INSTALL_CANDIDATES: readonly (readonly [string, ...string[]])[] = Object.freeze([
	["ProgramFiles", "PowerShell", "7", "pwsh.exe"],
	["ProgramFiles", "PowerShell", "6", "pwsh.exe"],
	["SystemRoot", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
]);

export function windowsCmdVerbatimArguments(
	executable: string,
	args: readonly string[],
): string[] | undefined {
	const name = win32.basename(executable).toLowerCase();
	if ((name !== "cmd" && name !== "cmd.exe") || args.length !== 4
		|| args[0]?.toLowerCase() !== "/d" || args[1]?.toLowerCase() !== "/s"
		|| args[2]?.toLowerCase() !== "/c") return undefined;
	// cmd /s /c strips this outer pair; its command text does not use CRT escaping.
	return [...args.slice(0, 3), `"${args[3]}"`];
}

export function resolveShellProfile(
	options: ResolveShellProfileOptions = {},
): ShellProfile {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const executable = resolveExecutable(platform, env, options);
	const kind = profileKind(platform, executable);
	return Object.freeze({
		kind,
		name: profileName(kind, executable),
		dialect: shellDialect(kind, executable),
		executable,
		execArgv: (command: string): readonly string[] => Object.freeze(
			kind === "powershell"
				? ["-NoLogo", "-NoProfile", "-Command", powershellUtf8Prelude(command)]
				: kind === "cmd"
					? ["/d", "/s", "/c", `chcp 65001>nul & ${command}`]
					: ["-lc", command],
		),
	});
}

// Windows consoles default to the ANSI/OEM code page, so children would emit
// GBK/Big5/... bytes that the UTF-8 output path cannot decode. Force UTF-8 for
// the lifetime of the command instead of guessing an encoding afterwards.
// PowerShell applies this to its own output and to native child processes that
// consult the console code page.
function powershellUtf8Prelude(command: string): string {
	return "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;"
		+ "$OutputEncoding=[System.Text.Encoding]::UTF8;"
		+ command;
}

function resolveExecutable(
	platform: NodeJS.Platform,
	env: Readonly<NodeJS.ProcessEnv>,
	options: ResolveShellProfileOptions,
): string {
	const pathExists = options.pathExists ?? existsSync;
	const find = options.findExecutable ?? findWindowsExecutable;
	const configured = options.shellPath?.trim()
		|| environmentValue(env, SHELL_PATH_ENV_KEY)?.trim();
	if (configured) {
		// POSIX paths are not validated here so a Windows or WSL host can still
		// describe a shell that only exists on the target platform.
		if (platform !== "win32") return configured;
		if (isBareCommand(configured)) {
			const resolved = find(configured, env, pathExists);
			if (resolved) return resolved;
		} else if (pathExists(configured)) {
			return configured;
		}
	}
	if (platform !== "win32") return environmentValue(env, "SHELL")?.trim() || "/bin/sh";
	for (const name of WINDOWS_POWERSHELL_NAMES) {
		const resolved = find(name, env, pathExists);
		if (resolved) return resolved;
	}
	return environmentValue(env, "ComSpec")?.trim() || "cmd.exe";
}

// Windows PowerShell ships with Windows while PowerShell 7 is optional, so the
// detection order keeps a fully UTF-8 shell first and CMD as the last resort.
function findWindowsExecutable(
	name: string,
	env: Readonly<NodeJS.ProcessEnv>,
	pathExists: (candidate: string) => boolean,
): string | undefined {
	// `pwsh` and `nushell` are commonly configured without the `.exe` suffix.
	for (const executableName of win32.basename(name).includes(".")
		? [name]
		: [name, `${name}.exe`]) {
		for (const directory of environmentValue(env, "PATH")?.split(win32.delimiter) ?? []) {
			const trimmed = directory.trim().replace(/^"|"$/gu, "");
			if (!trimmed) continue;
			const candidate = win32.join(trimmed, executableName);
			if (pathExists(candidate)) return candidate;
		}
		for (const install of WINDOWS_INSTALL_CANDIDATES) {
			const [rootName, ...relative] = install;
			if (!sameExecutableName(relative.at(-1), executableName)) continue;
			const root = environmentValue(env, rootName);
			if (!root) continue;
			const resolved = win32.join(root, ...relative);
			if (pathExists(resolved)) return resolved;
		}
	}
	return undefined;
}

function sameExecutableName(candidate: string | undefined, requested: string): boolean {
	if (!candidate) return false;
	const normalized = candidate.toLowerCase();
	const target = win32.basename(requested).toLowerCase();
	return normalized === target || (!target.includes(".") && normalized === `${target}.exe`);
}

function isBareCommand(value: string): boolean {
	return !value.includes("\\") && !value.includes("/");
}

function shellDialect(
	kind: ShellProfile["kind"],
	executable: string,
): ShellDialect {
	if (kind === "cmd") return "cmd";
	if (kind !== "powershell") return "posix-sh";
	const name = win32.basename(executable).toLowerCase().replace(/\.exe$/u, "");
	return name === "pwsh" ? "powershell-7" : "windows-powershell-5.1";
}

function profileKind(
	platform: NodeJS.Platform,
	executable: string,
): ShellProfile["kind"] {
	const name = win32.basename(executable).toLowerCase().replace(/\.exe$/u, "");
	if (name === "pwsh" || name === "powershell") return "powershell";
	if (name === "cmd") return "cmd";
	return platform === "win32" ? "cmd" : "posix";
}

function profileName(
	kind: ShellProfile["kind"],
	executable: string,
): ShellProfileName {
	if (kind !== "posix") return kind;
	const name = win32.basename(executable).toLowerCase();
	return name === "zsh" || name === "bash" || name === "sh" ? name : "posix";
}

function environmentValue(
	env: Readonly<NodeJS.ProcessEnv>,
	name: string,
): string | undefined {
	const normalized = name.toLowerCase();
	for (const [key, value] of Object.entries(env)) {
		if (key.toLowerCase() === normalized) return value;
	}
	return undefined;
}
