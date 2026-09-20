import { realpathSync } from "node:fs";
import { prependRipgrepToPath } from "../ripgrep/ripgrep-runtime.ts";

const CORE_ENVIRONMENT_KEYS = new Set([
	"COMSPEC",
	"HOME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LOCALAPPDATA",
	"PATH",
	"PATHEXT",
	"PWD",
	"SHELL",
	"SYSTEMROOT",
	"TEMP",
	"TERM",
	"TMP",
	"TMPDIR",
	"USER",
	"USERPROFILE",
	"WINDIR",
]);
const SECRET_LIKE_NAME = /(?:key|secret|token)/iu;

// Windows runtime essentials a command needs to launch native programs at all.
// PowerShell resolves executables through `PATHEXT` and the loader needs
// `SystemRoot`; without them a shell can exit 0 while the child never ran. They
// are filled from the host environment when a caller supplies a partial
// environment, and they carry no secrets or user data.
const WINDOWS_RUNTIME_KEYS = ["SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "PATHEXT", "COMSPEC"] as const;

export interface ShellEnvironmentInput {
	readonly cwd: string;
	readonly sourceEnv?: Readonly<NodeJS.ProcessEnv>;
	readonly platform?: NodeJS.Platform;
	readonly architecture?: string;
	readonly homeDir?: string;
	readonly packageRoot?: string;
	readonly platformPackageRoot?: string | null;
}

export interface ShellEnvironmentDiagnostics {
	readonly policy: "sanitized";
	readonly envKeys: readonly string[];
	readonly removedCount: number;
}

export interface ShellEnvironmentResult {
	readonly env: Readonly<NodeJS.ProcessEnv>;
	readonly diagnostics: ShellEnvironmentDiagnostics;
}

export function createShellEnvironment(input: ShellEnvironmentInput): ShellEnvironmentResult {
	if (!input.cwd.trim()) throw new TypeError("cwd must be non-empty");
	const source = input.sourceEnv ?? process.env;
	const env: Record<string, string> = {};
	let removedCount = 0;
	for (const [rawKey, value] of Object.entries(source)) {
		if (typeof value !== "string") continue;
		const key = rawKey.toUpperCase();
		if (SECRET_LIKE_NAME.test(key) || !CORE_ENVIRONMENT_KEYS.has(key)) {
			removedCount += 1;
			continue;
		}
		env[key] = value;
	}
	env.PWD = realpathSync(input.cwd);
	env.MYCLI_CI = "1";
	if ((input.platform ?? process.platform) === "win32") {
		// Keep Python and similar runtimes on UTF-8 instead of the console code page.
		env.PYTHONUTF8 = "1";
		env.PYTHONIOENCODING = "utf-8";
		for (const key of WINDOWS_RUNTIME_KEYS) {
			if (env[key] !== undefined) continue;
			// Prefer what the caller supplied, then fall back to the host runtime
			// plumbing so a partially sanitized environment still launches programs.
			const value = environmentValue(source, key) ?? environmentValue(process.env, key);
			if (value) env[key] = value;
		}
	}
	const ripgrep = prependRipgrepToPath({
		platform: input.platform ?? process.platform,
		architecture: input.architecture ?? process.arch,
		homeDir: input.homeDir ?? env.HOME ?? env.USERPROFILE,
		...(input.packageRoot ? { packageRoot: input.packageRoot } : {}),
		...(input.platformPackageRoot !== undefined
			? { platformPackageRoot: input.platformPackageRoot }
			: {}),
		pathValue: env.PATH,
	});
	env.PATH = ripgrep.path;
	if (ripgrep.directory) env.MYCLI_RIPGREP_PATH_DIR = ripgrep.directory;
	const frozenEnv = Object.freeze({ ...env });
	return Object.freeze({
		env: frozenEnv,
		diagnostics: Object.freeze({
			policy: "sanitized",
			envKeys: Object.freeze(Object.keys(frozenEnv).sort()),
			removedCount,
		}),
	});
}

function environmentValue(
	environment: Readonly<NodeJS.ProcessEnv>,
	key: string,
): string | undefined {
	const normalized = key.toLowerCase();
	for (const [name, value] of Object.entries(environment)) {
		if (name.toLowerCase() === normalized) return value;
	}
	return undefined;
}
