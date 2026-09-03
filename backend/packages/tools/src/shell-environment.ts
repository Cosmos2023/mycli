import { realpathSync } from "node:fs";
import { prependRipgrepToPath } from "./ripgrep-runtime.ts";

const CORE_ENVIRONMENT_KEYS = new Set([
	"COMSPEC",
	"HOME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
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
