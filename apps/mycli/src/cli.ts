#!/usr/bin/env node

import process from "node:process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	configureGatewayTransport,
	type GatewayTransport,
} from "mycli-shell-tui/gateway-transport";
import { selectRuntimeBackend } from "./backend-router.ts";
import {
	startNodeBackend,
	type NodeBackend,
	type StartNodeBackendOptions,
} from "./node-runtime/node-backend.ts";
import {
	startPythonSidecar,
	type PythonSidecar,
	type StartPythonSidecarOptions,
} from "./sidecar/python-sidecar.ts";

const VERSION = "0.1.0";
const HELP = `Usage: mycli [options]

Options:
  --session <id>                    Resume or create a session
  --model <model>                   Override the configured model
  --runtime-backend <backend>       Select python-sidecar or node
  -h, --help                        Show help
  -V, --version                     Show version
`;

type InputStream = { isTTY?: boolean };
type OutputStream = { isTTY?: boolean; write(value: string): unknown };
type ProcessHooks = {
	once(event: "exit", listener: (code: number) => void): unknown;
	once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
	off(event: "exit", listener: (code: number) => void): unknown;
	off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

export type RunCliOptions = {
	argv?: readonly string[];
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	stdin?: InputStream;
	stdout?: OutputStream;
	stderr?: OutputStream;
	processHooks?: ProcessHooks;
	startSidecar?: (options: StartPythonSidecarOptions) => PythonSidecar;
	startNodeBackend?: (options: StartNodeBackendOptions) => NodeBackend | Promise<NodeBackend>;
	configureTransport?: (transport: GatewayTransport) => void;
	importTui?: () => Promise<unknown>;
};

export async function runCli(options: RunCliOptions = {}): Promise<number> {
	const argv = options.argv ?? process.argv.slice(2);
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const stdin = options.stdin ?? process.stdin;
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;

	if (argv.includes("--help") || argv.includes("-h")) {
		stdout.write(HELP);
		return 0;
	}
	if (argv.includes("--version") || argv.includes("-V")) {
		stdout.write(`${VERSION}\n`);
		return 0;
	}

	let selectedBackend;
	try {
		selectedBackend = selectRuntimeBackend({ argv, env });
	} catch (error) {
		stderr.write(`[mycli] ${stableMessage(error, "runtime_backend_invalid")}\n`);
		return 2;
	}

	let backendArgs: readonly string[];
	try {
		backendArgs = parseRuntimeArguments(argv);
	} catch (error) {
		stderr.write(`[mycli] ${stableMessage(error, "invalid_arguments")}\n`);
		return 2;
	}

	if (stdin.isTTY !== true || stdout.isTTY !== true) {
		stderr.write("[mycli] tty_required: interactive mode requires terminal stdin and stdout\n");
		return 2;
	}

	let backend: PythonSidecar | NodeBackend;
	try {
		backend = selectedBackend === "node"
			? await (options.startNodeBackend ?? startNodeBackend)({ cwd, env, args: backendArgs })
			: (options.startSidecar ?? startPythonSidecar)({ cwd, env, args: backendArgs });
	} catch (error) {
		const fallback = selectedBackend === "node"
			? "node_backend_start_failed"
			: "sidecar_spawn_failed";
		stderr.write(`[mycli] ${stableMessage(error, fallback)}\n`);
		return 2;
	}

	let expectedShutdown = false;
	let childCompleted = false;
	let tuiOwned = false;
	let requestedExitCode: 0 | 130 | null = null;
	let gatewayShutdown: (() => Promise<unknown>) | null = null;
	let shutdownPromise: Promise<unknown> | null = null;
	const transport: GatewayTransport = {
		...backend.transport,
		close: async () => {
			expectedShutdown = true;
			await backend.close();
		},
	};
	const processHooks = options.processHooks ?? process;
	const onProcessExit = (): void => {
		if (!childCompleted) {
			backend.kill();
		}
	};
	const requestShutdown = (exitCode: 0 | 130): void => {
		requestedExitCode ??= exitCode;
		shutdownPromise ??= Promise.resolve(
			gatewayShutdown ? gatewayShutdown() : transport.close?.(),
		).catch(() => undefined);
	};
	const onSigint = (): void => {
		if (!tuiOwned) {
			requestShutdown(130);
		}
	};
	const onSigterm = (): void => requestShutdown(0);
	processHooks.once("exit", onProcessExit);
	processHooks.once("SIGINT", onSigint);
	processHooks.once("SIGTERM", onSigterm);

	try {
		(options.configureTransport ?? configureGatewayTransport)(transport);
		const tuiModule = await (options.importTui ?? (() => import("mycli-shell-tui/gateway")))();
		gatewayShutdown = gatewayShutdownFrom(tuiModule);
		await gatewayStartupFrom(tuiModule);
		tuiOwned = true;
	} catch {
		await backend.close().catch(() => undefined);
		removeLifecycleHooks(processHooks, onProcessExit, onSigint, onSigterm);
		if (requestedExitCode !== null) {
			return requestedExitCode;
		}
		stderr.write("[mycli] tui_start_failed: unable to start terminal UI\n");
		const diagnostic = backend.diagnostic().trim();
		if (diagnostic) {
			const prefix = selectedBackend === "node" ? "mycli-node" : "mycli-sidecar";
			stderr.write(`[${prefix}] ${diagnostic}\n`);
		}
		return 1;
	}

	let exitCode: number;
	try {
		exitCode = await backend.completion;
	} catch {
		exitCode = 1;
	} finally {
		childCompleted = true;
		removeLifecycleHooks(processHooks, onProcessExit, onSigint, onSigterm);
	}
	if (requestedExitCode !== null) {
		return requestedExitCode;
	}
	return expectedShutdown && exitCode === 0 ? 0 : 1;
}

function parseRuntimeArguments(argv: readonly string[]): readonly string[] {
	const runtimeArgs: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--runtime-backend") {
			index += 1;
			continue;
		}
		if (argument?.startsWith("--runtime-backend=")) {
			continue;
		}
		if (argument === "--session" || argument === "--model") {
			const value = argv[index + 1];
			if (value === undefined) {
				throw new Error(`invalid_arguments: ${argument} requires a value`);
			}
			runtimeArgs.push(argument, value);
			index += 1;
			continue;
		}
		if (argument?.startsWith("--session=") || argument?.startsWith("--model=")) {
			const separator = argument.indexOf("=");
			const flag = argument.slice(0, separator);
			const value = argument.slice(separator + 1);
			if (!value) {
				throw new Error(`invalid_arguments: ${flag} requires a value`);
			}
			runtimeArgs.push(flag, value);
			continue;
		}
		throw new Error("invalid_arguments: unsupported command or option");
	}
	return runtimeArgs;
}

function stableMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && /^[a-z][a-z0-9_]+: [^\r\n]+$/.test(error.message)) {
		return error.message;
	}
	return fallback;
}

function gatewayStartupFrom(value: unknown): Promise<unknown> {
	if (typeof value !== "object" || value === null || !("gatewayStartup" in value)) {
		return Promise.resolve();
	}
	const startup = value.gatewayStartup;
	return startup instanceof Promise ? startup : Promise.resolve();
}

function gatewayShutdownFrom(value: unknown): (() => Promise<unknown>) | null {
	if (typeof value !== "object" || value === null || !("gatewayShutdown" in value)) {
		return null;
	}
	const shutdown = value.gatewayShutdown;
	return typeof shutdown === "function"
		? () => Promise.resolve(shutdown())
		: null;
}

function removeLifecycleHooks(
	hooks: ProcessHooks,
	onExit: (code: number) => void,
	onSigint: () => void,
	onSigterm: () => void,
): void {
	hooks.off("exit", onExit);
	hooks.off("SIGINT", onSigint);
	hooks.off("SIGTERM", onSigterm);
}

const entryPath = process.argv[1];
if (entryPath && isEntrypoint(entryPath)) {
	void runCli().then((exitCode) => {
		process.exitCode = exitCode;
	});
}

function isEntrypoint(entryPath: string): boolean {
	try {
		return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}
