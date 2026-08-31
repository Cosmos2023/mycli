import { basename } from "node:path";
import type { DoctorCheck } from "./types.ts";

export interface TerminalDoctorOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly isTty?: boolean;
	readonly columns?: number;
	readonly rows?: number;
	readonly platform?: NodeJS.Platform;
}

const KNOWN_SHELLS = new Set([
	"bash",
	"cmd.exe",
	"fish",
	"nu",
	"nushell",
	"powershell.exe",
	"pwsh",
	"pwsh.exe",
	"sh",
	"zsh",
]);

export function collectTerminalChecks(options: TerminalDoctorOptions = {}): readonly DoctorCheck[] {
	const env = options.env ?? process.env;
	const isTty = options.isTty ?? process.stdout.isTTY === true;
	const columns = boundedDimension(options.columns ?? process.stdout.columns);
	const rows = boundedDimension(options.rows ?? process.stdout.rows);
	const shell = shellName(env, options.platform ?? process.platform);
	const dimensionsKnown = columns !== undefined && rows !== undefined;
	const dimensionsUsable = dimensionsKnown && columns >= 40 && rows >= 10;
	return Object.freeze([
		check(
			"terminal_tty",
			isTty ? "ok" : "warning",
			isTty ? "interactive terminal available" : "standard output is not an interactive terminal",
		),
		check(
			"terminal_size",
			dimensionsUsable ? "ok" : "warning",
			dimensionsKnown ? `columns=${columns} rows=${rows}` : "terminal dimensions unavailable",
		),
		check(
			"shell_selection",
			shell === "unknown" ? "warning" : "ok",
			`shell=${shell}`,
		),
	]);
}

function shellName(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
	const raw = platform === "win32" ? env.ComSpec : env.SHELL;
	if (!raw) return "unknown";
	const candidate = basename(raw.replaceAll("\\", "/")).toLowerCase();
	return KNOWN_SHELLS.has(candidate) ? candidate : "unknown";
}

function boundedDimension(value: number | undefined): number | undefined {
	return Number.isSafeInteger(value) && value !== undefined && value > 0 && value <= 10_000
		? value
		: undefined;
}

function check(
	name: string,
	status: DoctorCheck["status"],
	message: string,
): DoctorCheck {
	return Object.freeze({ name, status, message, category: "terminal", code: name });
}
