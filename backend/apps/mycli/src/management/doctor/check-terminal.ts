import { resolveShellProfile } from "@mycli/tools";
import type { DoctorCheck } from "./types.ts";

interface TerminalDoctorOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly isTty?: boolean;
	readonly columns?: number;
	readonly rows?: number;
	readonly platform?: NodeJS.Platform;
}

export function collectTerminalChecks(options: TerminalDoctorOptions = {}): readonly DoctorCheck[] {
	const env = options.env ?? process.env;
	const isTty = options.isTty ?? process.stdout.isTTY === true;
	const columns = boundedDimension(options.columns ?? process.stdout.columns);
	const rows = boundedDimension(options.rows ?? process.stdout.rows);
	const shell = resolveShellProfile({ env, platform: options.platform });
	const configured = (env.MYCLI_SHELL_PATH ?? "").trim();
	const configuredIgnored = configured.length > 0 && shell.executable !== configured;
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
			configuredIgnored ? "warning" : "ok",
			configuredIgnored
				? `shell=${shell.name} dialect=${shell.dialect} configured_shell_ignored=true`
				: `shell=${shell.name} dialect=${shell.dialect}`,
		),
	]);
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
