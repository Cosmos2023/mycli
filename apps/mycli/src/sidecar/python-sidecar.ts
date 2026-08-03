import { spawn as nodeSpawn } from "node:child_process";
import process from "node:process";
import type { Readable, Writable } from "node:stream";
import type { GatewayTransport } from "mycli-shell-tui/gateway-transport";

const STDERR_LIMIT_BYTES = 8 * 1024;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const SECRET_ASSIGNMENT = /\b(api[_-]?key|apikey|x-api-key|token|secret|password)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER_TOKEN = /\b(Bearer\s+)[A-Za-z0-9_./+=:-]{6,}\b/gi;
const API_KEY_VALUE = /\bsk-[A-Za-z0-9_-]{6,}\b/g;

export type SpawnedSidecar = {
	stdin: Writable | null;
	stdout: Readable | null;
	stderr: Readable | null;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	once(event: "error", listener: (error: Error) => void): unknown;
	once(
		event: "exit",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): unknown;
	kill(signal?: NodeJS.Signals | number): boolean;
};

export type SidecarSpawnOptions = {
	cwd: string;
	env: NodeJS.ProcessEnv;
	stdio: ["pipe", "pipe", "pipe"];
	windowsHide: true;
	shell: false;
};

export type SpawnSidecar = (
	command: string,
	args: readonly string[],
	options: SidecarSpawnOptions,
) => SpawnedSidecar;

export type SidecarTimers = {
	setTimeout(callback: () => void, delayMs: number): object;
	clearTimeout(handle: object): void;
};

export type StartPythonSidecarOptions = {
	cwd: string;
	env: NodeJS.ProcessEnv;
	args: readonly string[];
	platform?: NodeJS.Platform;
	spawn?: SpawnSidecar;
	timers?: SidecarTimers;
};

export type PythonSidecar = {
	transport: GatewayTransport;
	completion: Promise<number>;
	diagnostic: () => string;
	close: () => Promise<void>;
	kill: () => void;
};

const nativeTimers: SidecarTimers = {
	setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
	clearTimeout: (handle) => globalThis.clearTimeout(handle as NodeJS.Timeout),
};

const spawnSidecar: SpawnSidecar = (command, args, options) =>
	nodeSpawn(command, [...args], options);

export function startPythonSidecar(options: StartPythonSidecarOptions): PythonSidecar {
	const platform = options.platform ?? process.platform;
	const executable = options.env.MYCLI_PYTHON || (platform === "win32" ? "python" : "python3");
	const commandArgs = ["-m", "mycli.cli.sidecar", ...options.args];
	const spawn = options.spawn ?? spawnSidecar;
	let child: SpawnedSidecar;

	try {
		child = spawn(executable, commandArgs, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			shell: false,
		});
	} catch {
		throw spawnFailure();
	}

	if (child.stdin === null || child.stdout === null) {
		child.kill("SIGKILL");
		throw spawnFailure();
	}

	let stderr = Buffer.alloc(0);
	child.stderr?.on("data", (chunk: Buffer | string) => {
		if (stderr.length >= STDERR_LIMIT_BYTES) {
			return;
		}
		const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		const remaining = STDERR_LIMIT_BYTES - stderr.length;
		stderr = Buffer.concat([stderr, incoming.subarray(0, remaining)]);
	});

	const completion = new Promise<number>((resolve, reject) => {
		child.once("error", () => reject(spawnFailure()));
		child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 0 : 1)));
	});
	const timers = options.timers ?? nativeTimers;
	let closePromise: Promise<void> | null = null;
	let killed = false;
	const kill = (): void => {
		if (!killed && !hasExited(child)) {
			killed = true;
			child.kill("SIGKILL");
		}
	};

	const close = (): Promise<void> => {
		closePromise ??= closeSidecar(child, completion, timers);
		return closePromise;
	};

	return {
		transport: {
			input: child.stdout,
			output: child.stdin,
			close,
		},
		completion,
		diagnostic: () => boundedDiagnostic(stderr.toString("utf8")),
		close,
		kill,
	};
}

async function closeSidecar(
	child: SpawnedSidecar,
	completion: Promise<number>,
	timers: SidecarTimers,
): Promise<void> {
	child.stdin?.end();
	if (hasExited(child) || await settlesBeforeTimeout(completion, timers)) {
		return;
	}

	child.kill("SIGTERM");
	if (hasExited(child) || await settlesBeforeTimeout(completion, timers)) {
		return;
	}

	child.kill("SIGKILL");
	await completion.catch(() => undefined);
}

function settlesBeforeTimeout(completion: Promise<number>, timers: SidecarTimers): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = timers.setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve(false);
			}
		}, SHUTDOWN_TIMEOUT_MS);

		void completion.then(
			() => finish(true),
			() => finish(true),
		);

		function finish(value: boolean): void {
			if (settled) {
				return;
			}
			settled = true;
			timers.clearTimeout(timer);
			resolve(value);
		}
	});
}

function hasExited(child: SpawnedSidecar): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

function boundedDiagnostic(value: string): string {
	const redacted = value
		.replace(SECRET_ASSIGNMENT, "$1=[REDACTED]")
		.replace(BEARER_TOKEN, "$1[REDACTED]")
		.replace(API_KEY_VALUE, "[REDACTED]");
	const bytes = Buffer.from(redacted);
	if (bytes.length <= STDERR_LIMIT_BYTES) {
		return redacted;
	}
	return bytes.subarray(0, STDERR_LIMIT_BYTES).toString("utf8").replace(/\uFFFD$/, "");
}

function spawnFailure(): Error {
	return new Error("sidecar_spawn_failed: unable to start Python sidecar");
}
