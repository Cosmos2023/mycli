import { spawn } from "node:child_process";
import { once } from "node:events";

const RAISED_ENV = "MYCLI_FD_LIMIT_RAISED";
const PROBE_TIMEOUT_MS = 2_000;
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

/**
 * A long session keeps SQLite, MCP, shell, PTY and proxy sockets open at once.
 * libuv already raises the macOS soft limit to the hard limit, but Linux logins
 * commonly inherit 1024, so the app-server raises its own limit instead of failing
 * later with EMFILE.
 */
export const FD_SOFT_LIMIT_TARGET = 8_192;

/** Shell prefix that raises the soft limit, then replaces itself with the real command. */
export function fdLimitShellCommand(target: number): string {
	return `ulimit -n ${target} 2>/dev/null; exec "$0" "$@"`;
}

export interface FdLimitRaiseOptions {
	readonly platform: NodeJS.Platform;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** Complete replacement command line: `[nodePath, ...nodeFlags, entryScript, ...argv]`. */
	readonly command: readonly string[];
	readonly target?: number;
	/** Injection seams for tests; both default to bounded `/bin/sh` children. */
	readonly readSoftLimit?: () => Promise<number | undefined>;
	readonly reexec?: (command: readonly string[], env: NodeJS.ProcessEnv, target: number) => Promise<number>;
}

/**
 * Node exposes no rlimit API, so a low soft limit is raised by replacing the process
 * image once with a shell that runs `ulimit` and `exec`s the same command. Returns the
 * replacement's exit code, or `undefined` when this process must continue unchanged.
 */
export async function raiseFdSoftLimit(options: FdLimitRaiseOptions): Promise<number | undefined> {
	if (options.platform === "win32" || options.env[RAISED_ENV] === "1") return undefined;
	const target = options.target ?? FD_SOFT_LIMIT_TARGET;
	let soft: number | undefined;
	try {
		soft = await (options.readSoftLimit ?? readSoftLimit)();
	} catch {
		return undefined;
	}
	if (soft === undefined || soft >= target) return undefined;
	const env = { ...options.env, [RAISED_ENV]: "1" };
	return await (options.reexec ?? reexec)(options.command, env, target);
}

async function readSoftLimit(): Promise<number | undefined> {
	const child = spawn("/bin/sh", ["-c", "ulimit -n"], { stdio: ["ignore", "pipe", "ignore"] });
	const timer = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
	timer.unref();
	try {
		let text = "";
		for await (const chunk of child.stdout) text += String(chunk);
		// "close" always follows a spawn error, so a failed probe cannot hang startup.
		const [code] = await once(child, "close");
		const value = Number.parseInt(text.trim(), 10);
		return code === 0 && Number.isSafeInteger(value) && value > 0 ? value : undefined;
	} finally {
		clearTimeout(timer);
	}
}

/** `exec` keeps the inherited stdio, the terminal process group and the exit code. */
function reexec(command: readonly string[], env: NodeJS.ProcessEnv, target: number): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn("/bin/sh", ["-c", fdLimitShellCommand(target), ...command],
			{ stdio: "inherit", env });
		const forward = (signal: NodeJS.Signals): void => { child.kill(signal); };
		for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
		const settle = (code: number): void => {
			for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
			resolve(code);
		};
		child.once("error", () => settle(1));
		child.once("exit", (code, signal) => settle(signal === null ? code ?? 1 : SIGNAL_EXIT_CODES[signal] ?? 1));
	});
}
