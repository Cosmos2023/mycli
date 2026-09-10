import { win32 } from "node:path";

export type ShellProfileName = "zsh" | "bash" | "sh" | "powershell" | "cmd" | "posix";

export interface ShellProfile {
	readonly kind: "posix" | "powershell" | "cmd";
	readonly name: ShellProfileName;
	readonly executable: string;
	execArgv(command: string): readonly string[];
}

export interface ResolveShellProfileOptions {
	readonly platform?: NodeJS.Platform;
	readonly env?: Readonly<NodeJS.ProcessEnv>;
	readonly shellPath?: string;
}

export function resolveShellProfile(
	options: ResolveShellProfileOptions = {},
): ShellProfile {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const configured = options.shellPath?.trim();
	const executable = configured || defaultExecutable(platform, env);
	const kind = profileKind(platform, executable);
	return Object.freeze({
		kind,
		name: profileName(kind, executable),
		executable,
		execArgv: (command: string): readonly string[] => Object.freeze(
			kind === "powershell"
				? ["-NoLogo", "-NoProfile", "-Command", command]
				: kind === "cmd"
					? ["/d", "/s", "/c", command]
					: ["-lc", command],
		),
	});
}

function defaultExecutable(
	platform: NodeJS.Platform,
	env: Readonly<NodeJS.ProcessEnv>,
): string {
	if (platform !== "win32") return environmentValue(env, "SHELL")?.trim() || "/bin/sh";
	return environmentValue(env, "ComSpec")?.trim() || "cmd.exe";
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
