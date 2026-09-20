import { spawn } from "node:child_process";
import process from "node:process";
import type { ProcessCleanupResult } from "./shell-transport.ts";

const INTERRUPT_GRACE_MS = 500;
const TERMINATE_GRACE_MS = 50;
const KILL_GRACE_MS = 500;

export interface ManagedProcess {
	readonly pid: number;
	readonly exitCode: number | null;
	readonly signalCode: NodeJS.Signals | null;
	kill(signal?: NodeJS.Signals | number): boolean;
}

export interface WindowsTaskkillRequest {
	readonly executable: "taskkill.exe";
	readonly args: readonly ["/PID", string, "/T", "/F"];
	readonly shell: false;
	readonly windowsHide: true;
}

export interface ProcessControllerOptions {
	readonly platform?: NodeJS.Platform;
	readonly sendSignal?: (targetPid: number, signal: NodeJS.Signals) => void;
	readonly isProcessTreeAlive?: (targetPid: number) => boolean;
	readonly waitForTreeExit?: (timeoutMs: number) => Promise<boolean>;
	readonly runTaskkill?: (request: WindowsTaskkillRequest) => Promise<number>;
}

export interface ProcessController {
	interrupt(): Promise<ProcessCleanupResult>;
	terminate(): Promise<ProcessCleanupResult>;
}

export function createProcessController(
	managed: ManagedProcess,
	options: ProcessControllerOptions = {},
): ProcessController {
	if (!Number.isSafeInteger(managed.pid) || managed.pid <= 0) {
		throw new RangeError("managed process pid must be a positive safe integer");
	}
	const platform = options.platform ?? process.platform;
	const targetPid = platform === "win32" ? managed.pid : -managed.pid;
	const isTreeAlive = options.isProcessTreeAlive ?? nativeTreeProbe;
	const waitForTreeExit = options.waitForTreeExit
		?? ((timeoutMs: number) => waitUntilStopped(targetPid, isTreeAlive, timeoutMs));
	const sendSignal = options.sendSignal ?? nativeSignal;
	const runTaskkill = options.runTaskkill ?? runNativeTaskkill;

	return Object.freeze({
		interrupt: () => cleanup(true),
		terminate: () => cleanup(false),
	});

	async function cleanup(preferInterrupt: boolean): Promise<ProcessCleanupResult> {
		if (!isTreeAlive(targetPid)) return exitedResult(managed);
		return platform === "win32"
			? cleanupWindows(preferInterrupt)
			: cleanupPosix(preferInterrupt);
	}

	async function cleanupPosix(preferInterrupt: boolean): Promise<ProcessCleanupResult> {
		const stages: ReadonlyArray<{
			readonly signal: NodeJS.Signals;
			readonly timeoutMs: number;
			readonly state: "interrupted" | "terminated";
		}> = preferInterrupt
			? [
				{ signal: "SIGINT", timeoutMs: INTERRUPT_GRACE_MS, state: "interrupted" },
				{ signal: "SIGTERM", timeoutMs: TERMINATE_GRACE_MS, state: "terminated" },
				{ signal: "SIGKILL", timeoutMs: KILL_GRACE_MS, state: "terminated" },
			]
			: [
				{ signal: "SIGTERM", timeoutMs: TERMINATE_GRACE_MS, state: "terminated" },
				{ signal: "SIGKILL", timeoutMs: KILL_GRACE_MS, state: "terminated" },
			];

		let lastSignal: NodeJS.Signals = preferInterrupt ? "SIGINT" : "SIGTERM";
		for (const stage of stages) {
			lastSignal = stage.signal;
			if (!isTreeAlive(targetPid)) return exitedResult(managed);
			try {
				sendSignal(targetPid, stage.signal);
			} catch (error: unknown) {
				if (isMissingProcess(error) || !isTreeAlive(targetPid)) {
					return { state: stage.state, signal: stage.signal };
				}
				continue;
			}
			if (await waitForTreeExit(stage.timeoutMs) || !isTreeAlive(targetPid)) {
				return { state: stage.state, signal: stage.signal };
			}
		}
		return { state: "inconclusive", signal: lastSignal };
	}

	async function cleanupWindows(preferInterrupt: boolean): Promise<ProcessCleanupResult> {
		if (preferInterrupt) {
			let delivered = false;
			try {
				delivered = managed.kill("SIGBREAK");
			} catch {
				// Continue to the fixed process-tree termination path.
			}
			if (delivered && (await waitForTreeExit(INTERRUPT_GRACE_MS) || !isTreeAlive(targetPid))) {
				return { state: "interrupted", signal: "SIGBREAK" };
			}
		}

		let taskkillExitCode: number;
		try {
			taskkillExitCode = await runTaskkill(taskkillRequest(managed.pid));
		} catch {
			return { state: "inconclusive", signal: "SIGKILL" };
		}
		if (taskkillExitCode !== 0) {
			return !isTreeAlive(targetPid)
				? { state: "terminated", signal: "SIGKILL" }
				: { state: "inconclusive", signal: "SIGKILL" };
		}
		return await waitForTreeExit(KILL_GRACE_MS) || !isTreeAlive(targetPid)
			? { state: "terminated", signal: "SIGKILL" }
			: { state: "inconclusive", signal: "SIGKILL" };
	}
}

function taskkillRequest(pid: number): WindowsTaskkillRequest {
	return Object.freeze({
		executable: "taskkill.exe",
		args: ["/PID", String(pid), "/T", "/F"] as const,
		shell: false,
		windowsHide: true,
	});
}

function exitedResult(managed: ManagedProcess): ProcessCleanupResult {
	return {
		state: "already_exited",
		...(managed.exitCode === null ? {} : { exitCode: managed.exitCode }),
		...(managed.signalCode === null ? {} : { signal: managed.signalCode }),
	};
}

function nativeSignal(targetPid: number, signal: NodeJS.Signals): void {
	process.kill(targetPid, signal);
}

function nativeTreeProbe(targetPid: number): boolean {
	try {
		process.kill(targetPid, 0);
		return true;
	} catch (error: unknown) {
		return !isMissingProcess(error);
	}
}

async function waitUntilStopped(
	targetPid: number,
	isTreeAlive: (targetPid: number) => boolean,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isTreeAlive(targetPid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return !isTreeAlive(targetPid);
}

function isMissingProcess(error: unknown): boolean {
	return error instanceof Error
		&& "code" in error
		&& (error as NodeJS.ErrnoException).code === "ESRCH";
}

function runNativeTaskkill(request: WindowsTaskkillRequest): Promise<number> {
	return new Promise((resolve, reject) => {
		const command = spawn(request.executable, [...request.args], {
			shell: request.shell,
			windowsHide: request.windowsHide,
			stdio: "ignore",
		});
		command.once("error", reject);
		command.once("close", (code) => resolve(code ?? 1));
	});
}
