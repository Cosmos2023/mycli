#!/usr/bin/env node

import process from "node:process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseConfigProfileName } from "@mycli/config/profile";
import { initializeRipgrepEnvironment } from "@mycli/tools/ripgrep-runtime";
import {
	configureGatewayTransport,
	type GatewayTransport,
} from "mycli-shell-tui/gateway-transport";
import { parseCliMode } from "./management/parser.ts";
import { renderManagementResponse } from "./management/render.ts";
import type { SetupInputStream, SetupOutputStream } from "./management/setup.ts";
import type { ManagementCommand, ManagementExecutor } from "./management/types.ts";
import type {
	NodeBackend,
	StartNodeBackendOptions,
} from "./node-runtime/node-backend.ts";
import { startSupervisedNodeBackend } from "./node-runtime/node-backend-supervisor.ts";
import {
	StartupProfiler,
	startupProfileEnabled,
	writeStartupProfile,
} from "./node-runtime/startup-profile.ts";
import { MYCLI_VERSION } from "./version.ts";

export const ROOT_HELP = `Usage: mycli [options]
       mycli <command> [arguments]

Commands:
  setup                             Configure provider credentials
  config validate|show|get|set|unset|path|migrate
                                    Validate, inspect, migrate, or locate configuration
  doctor [--json] [--verbose]       Check local runtime health
  update [status|check|dismiss <version>] [--json]
                                    Inspect or dismiss cached update notices
  sandbox status [--json]           Inspect platform sandbox readiness
  hooks list|inspect|approve|revoke Manage configured hooks
  plugins list|inspect|run          Manage local plugins
  mcp list|inspect                  Inspect MCP servers
  session list|resume|fork|rename|archive|unarchive|delete|export
                                    Discover and manage local sessions
Options:
  --session <id>                    Resume or create a session
  --model <model>                   Override the configured model
  -p, --profile <name>              Select a launch-scoped configuration profile
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
	startNodeBackend?: (options: StartNodeBackendOptions) => NodeBackend | Promise<NodeBackend>;
	configureTransport?: (transport: GatewayTransport) => void;
	importTui?: () => Promise<unknown>;
	management?: ManagementExecutor;
	homeDir?: string;
};

export async function runCli(options: RunCliOptions = {}): Promise<number> {
	const argv = options.argv ?? process.argv.slice(2);
	const env = options.env ?? process.env;
	const startupProfiler = new StartupProfiler({
		enabled: startupProfileEnabled(env),
		scope: "cli",
		origin: 0,
	});
	startupProfiler.mark("module_ready");
	initializeRipgrepEnvironment({ env, ...(options.homeDir ? { homeDir: options.homeDir } : {}) });
	const cwd = options.cwd ?? process.cwd();
	const stdin = options.stdin ?? process.stdin;
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;

	if (argv.includes("--help") || argv.includes("-h")) {
		stdout.write(ROOT_HELP);
		return 0;
	}
	if (argv.includes("--version") || argv.includes("-V")) {
		stdout.write(`${MYCLI_VERSION}\n`);
		return 0;
	}

	let mode;
	try {
		mode = parseCliMode(argv);
	} catch (error) {
		stderr.write(`[mycli] ${stableMessage(error, "invalid_arguments")}\n`);
		return 2;
	}
	if (mode.kind === "management") {
		try {
			const homeDir = options.homeDir ?? homedir();
			const management = options.management ?? await (async () => {
				if (mode.command.kind === "sandbox") {
					const { inspectSandboxStatus } = await import("./management/sandbox.ts");
					const executor: ManagementExecutor = {
						execute: (
							_command: ManagementCommand,
							signal = new AbortController().signal,
						) => inspectSandboxStatus({}, signal),
					};
					return executor;
				}
				const [{ createDefaultManagementServices }, { runSetupCommand }] = await Promise.all([
					import("./management/services.ts"),
					import("./management/setup.ts"),
				]);
				return createDefaultManagementServices({
					workspaceRoot: cwd,
					homeDir,
					env,
					setup: (signal) => runSetupCommand({
						homeDir,
						isTty: stdin.isTTY === true && stdout.isTTY === true,
						input: stdin as SetupInputStream,
						output: stdout as SetupOutputStream,
						signal,
					}),
				});
			})();
			const response = await management.execute(mode.command, new AbortController().signal);
			stdout.write(renderManagementResponse(mode.command, response));
			return response.exitCode ?? (response.ok ? 0 : 1);
		} catch {
			stderr.write("[mycli] management_start_failed: unable to run management command\n");
			return 1;
		}
	}

	let backendArgs: readonly string[];
	try {
		backendArgs = parseRuntimeArguments(mode.runtimeArgs);
	} catch (error) {
		stderr.write(`[mycli] ${stableMessage(error, "invalid_arguments")}\n`);
		return 2;
	}

	if (stdin.isTTY !== true || stdout.isTTY !== true) {
		stderr.write("[mycli] tty_required: interactive mode requires terminal stdin and stdout\n");
		return 2;
	}

	let expectedShutdown = false;
	let childCompleted = false;
	let tuiOwned = false;
	let requestedExitCode: 0 | 130 | null = null;
	let gatewayShutdown: (() => Promise<unknown>) | null = null;
	let shutdownPromise: Promise<unknown> | null = null;
	const deferredInput = new PassThrough();
	const deferredOutput = new PassThrough();
	let backendStart: Promise<NodeBackend>;
	let resolvedBackend: NodeBackend | undefined;
	try {
		const started = (options.startNodeBackend ?? startSupervisedNodeBackend)({
			cwd,
			env,
			args: backendArgs,
		});
		if (isNodeBackend(started)) resolvedBackend = started;
		backendStart = Promise.resolve(started).then((running) => {
			resolvedBackend = running;
			return running;
		});
	} catch (error) {
		stderr.write(`[mycli] ${stableMessage(error, "node_backend_start_failed")}\n`);
		return 2;
	}
	const transport: GatewayTransport = {
		input: deferredInput,
		output: deferredOutput,
		close: async () => {
			expectedShutdown = true;
			const running = await backendStart.catch(() => undefined);
			await running?.close();
		},
	};
	const processHooks = options.processHooks ?? process;
	const onProcessExit = (): void => {
		if (childCompleted) return;
		if (resolvedBackend) {
			resolvedBackend.kill();
			return;
		}
		void backendStart.then((running) => running.kill(), () => undefined);
	};
	const requestShutdown = (exitCode: 0 | 130): void => {
		requestedExitCode ??= exitCode;
		shutdownPromise ??= Promise.resolve(
			gatewayShutdown ? gatewayShutdown() : transport.close?.(),
		).catch(() => undefined);
	};
	const onSigint = (): void => {
		if (!tuiOwned) requestShutdown(130);
	};
	const onSigterm = (): void => requestShutdown(0);
	processHooks.once("exit", onProcessExit);
	processHooks.once("SIGINT", onSigint);
	processHooks.once("SIGTERM", onSigterm);
	try {
		(options.configureTransport ?? configureGatewayTransport)(transport);
	} catch {
		await backendStart.then((running) => running.close(), () => undefined);
		removeLifecycleHooks(processHooks, onProcessExit, onSigint, onSigterm);
		stderr.write("[mycli] tui_start_failed: unable to start terminal UI\n");
		return 1;
	}
	let tuiImport: Promise<unknown>;
	try {
		tuiImport = (options.importTui ?? (() => import("mycli-shell-tui/gateway")))();
	} catch {
		await backendStart.then((running) => running.close(), () => undefined);
		removeLifecycleHooks(processHooks, onProcessExit, onSigint, onSigterm);
		stderr.write("[mycli] tui_start_failed: unable to start terminal UI\n");
		return 1;
	}
	void tuiImport.then(gatewayStartupFrom, () => undefined).catch(() => undefined);

	let backend: NodeBackend;
	try {
		backend = await backendStart;
		startupProfiler.mark("backend_ready");
	} catch (error) {
		deferredInput.end();
		deferredOutput.destroy();
		await tuiImport.catch(() => undefined);
		removeLifecycleHooks(processHooks, onProcessExit, onSigint, onSigterm);
		stderr.write(`[mycli] ${stableMessage(error, "node_backend_start_failed")}\n`);
		return 2;
	}
	backend.transport.input.pipe(deferredInput);
	deferredOutput.pipe(backend.transport.output);

	try {
		const tuiModule = await tuiImport;
		gatewayShutdown = gatewayShutdownFrom(tuiModule);
		await gatewayStartupFrom(tuiModule);
		tuiOwned = true;
		startupProfiler.mark("tui_ready");
		await writeStartupProfile({
			homeDir: options.homeDir ?? env.HOME?.trim() ?? env.USERPROFILE?.trim() ?? homedir(),
			profiles: [startupProfiler.snapshot(), backend.startupProfile?.()].flatMap(
				(profile) => profile ? [profile] : [],
			),
		});
	} catch {
		await backend.close().catch(() => undefined);
		removeLifecycleHooks(processHooks, onProcessExit, onSigint, onSigterm);
		if (requestedExitCode !== null) {
			return requestedExitCode;
		}
		stderr.write("[mycli] tui_start_failed: unable to start terminal UI\n");
		const diagnostic = backend.diagnostic().trim();
		if (diagnostic) {
			stderr.write(`[mycli-node] ${diagnostic}\n`);
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
	let profileSeen = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--session" || argument === "--model"
			|| argument === "--profile" || argument === "-p") {
			const value = argv[index + 1];
			if (value === undefined) {
				throw new Error(`invalid_arguments: ${argument} requires a value`);
			}
			if (argument === "--profile" || argument === "-p") {
				if (profileSeen) throw new Error("invalid_arguments: duplicate --profile");
				profileSeen = true;
				runtimeArgs.push("--profile", validatedProfileName(value));
			} else {
				runtimeArgs.push(argument, value);
			}
			index += 1;
			continue;
		}
		if (argument?.startsWith("--session=")
			|| argument?.startsWith("--model=")
			|| argument?.startsWith("--profile=")
			|| argument?.startsWith("-p=")) {
			const separator = argument.indexOf("=");
			const flag = argument.slice(0, separator);
			const value = argument.slice(separator + 1);
			if (!value) {
				throw new Error(`invalid_arguments: ${flag} requires a value`);
			}
			if (flag === "--profile" || flag === "-p") {
				if (profileSeen) throw new Error("invalid_arguments: duplicate --profile");
				profileSeen = true;
				runtimeArgs.push("--profile", validatedProfileName(value));
			} else {
				runtimeArgs.push(flag, value);
			}
			continue;
		}
		throw new Error("invalid_arguments: unsupported command or option");
	}
	return runtimeArgs;
}

function validatedProfileName(value: string): string {
	try {
		return parseConfigProfileName(value);
	} catch {
		throw new Error(
			"invalid_arguments: profile name may contain only ASCII letters, digits, '_' or '-'",
		);
	}
}

function stableMessage(error: unknown, fallback: string): string {
	if (error instanceof Error && /^[a-z][a-z0-9_]+: [^\r\n]+$/.test(error.message)) {
		return error.message;
	}
	return fallback;
}

function isNodeBackend(value: NodeBackend | Promise<NodeBackend>): value is NodeBackend {
	return typeof value === "object" && value !== null && "transport" in value;
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
