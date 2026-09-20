import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Readable } from "node:stream";
import { windowsCmdVerbatimArguments } from "./shell-profile.ts";
import {
	createProcessController,
	type ProcessController,
	type ProcessControllerOptions,
} from "./process-controller.ts";
import {
	ShellTransportError,
	type ProcessCleanupResult,
	type ShellExit,
	type ShellOutputChunk,
	type ShellStream,
	type ShellTransport,
	type ShellTransportStartRequest,
} from "./shell-transport.ts";

export interface StartPipeTransportOptions {
	readonly processController?: ProcessControllerOptions;
}

export async function startPipeTransport(
	request: ShellTransportStartRequest,
	options: StartPipeTransportOptions = {},
): Promise<ShellTransport> {
	validateRequest(request);
	const verbatim = request.platform === "win32"
		? windowsCmdVerbatimArguments(request.executable, request.args) : undefined;
	const child = spawn(request.executable, verbatim ?? [...request.args], {
		cwd: request.cwd,
		env: { ...request.env },
		detached: request.platform !== "win32",
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
		windowsVerbatimArguments: verbatim !== undefined,
	});
	try {
		await once(child, "spawn");
	} catch {
		child.stdout?.destroy();
		child.stderr?.destroy();
		throw shellSpawnFailure();
	}
	if (child.pid === undefined || child.stdout === null || child.stderr === null) {
		child.stdout?.destroy();
		child.stderr?.destroy();
		throw shellSpawnFailure();
	}
	const transport = new PipeTransport(
		child,
		child.stdout,
		child.stderr,
		createProcessController({
			pid: child.pid,
			get exitCode() {
				return child.exitCode;
			},
			get signalCode() {
				return child.signalCode;
			},
			// Node cannot deliver console control events through a Windows pipe process.
			kill: (signal) => request.platform === "win32" && signal === "SIGBREAK"
				? false : child.kill(signal),
		}, {
			...options.processController,
			platform: request.platform,
		}),
	);
	return transport;
}

class PipeTransport implements ShellTransport {
	readonly kind = "pipe" as const;
	readonly tty = false;
	readonly pid: number;
	readonly #child;
	readonly #stdout: Readable;
	readonly #stderr: Readable;
	readonly #controller: ProcessController;
	readonly #outputListeners = new Set<(chunk: ShellOutputChunk) => void>();
	readonly #exitListeners = new Set<(exit: ShellExit) => void>();
	#pendingOutput: ShellOutputChunk[] = [];
	#outputReplayScheduled = false;
	#hasOutputSubscriber = false;
	#sequence = 0;
	#exit: ShellExit | undefined;
	#closed = false;

	constructor(
		child: ReturnType<typeof spawn>,
		stdout: Readable,
		stderr: Readable,
		controller: ProcessController,
	) {
		if (child.pid === undefined) throw shellSpawnFailure();
		this.pid = child.pid;
		this.#child = child;
		this.#stdout = stdout;
		this.#stderr = stderr;
		this.#controller = controller;
		stdout.on("data", this.#onStdout);
		stderr.on("data", this.#onStderr);
		child.once("close", this.#onClose);
		child.on("error", this.#onError);
	}

	onOutput(listener: (chunk: ShellOutputChunk) => void): () => void {
		if (this.#closed) return () => undefined;
		this.#outputListeners.add(listener);
		if (!this.#hasOutputSubscriber) {
			this.#hasOutputSubscriber = true;
			this.#scheduleOutputReplay();
		}
		return () => this.#outputListeners.delete(listener);
	}

	onExit(listener: (exit: ShellExit) => void): () => void {
		if (this.#closed) return () => undefined;
		this.#exitListeners.add(listener);
		const exit = this.#exit;
		if (exit !== undefined) {
			queueMicrotask(() => {
				if (this.#exitListeners.has(listener)) listener(exit);
			});
		}
		return () => this.#exitListeners.delete(listener);
	}

	async write(text: string): Promise<void> {
		void text;
		throw new ShellTransportError(
			"stdin_closed",
			"Shell stdin is closed; rerun Shell with tty=true to send input.",
		);
	}

	async resize(rows: number, columns: number): Promise<void> {
		void rows;
		void columns;
		throw new ShellTransportError("shell_resize_failed", "Pipe sessions cannot be resized.");
	}

	interrupt(): Promise<ProcessCleanupResult> {
		return this.#controller.interrupt();
	}

	terminate(): Promise<ProcessCleanupResult> {
		return this.#controller.terminate();
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#stdout.off("data", this.#onStdout);
		this.#stderr.off("data", this.#onStderr);
		this.#child.off("close", this.#onClose);
		this.#child.off("error", this.#onError);
		this.#stdout.destroy();
		this.#stderr.destroy();
		this.#pendingOutput = [];
		this.#outputListeners.clear();
		this.#exitListeners.clear();
	}

	readonly #onStdout = (data: Buffer | string): void => this.#publishOutput("stdout", data);
	readonly #onStderr = (data: Buffer | string): void => this.#publishOutput("stderr", data);
	readonly #onClose = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
		if (this.#exit !== undefined) return;
		const exit = Object.freeze({ exitCode, signal });
		this.#exit = exit;
		for (const listener of this.#exitListeners) listener(exit);
	};
	readonly #onError = (): void => undefined;

	#publishOutput(stream: ShellStream, data: Buffer | string): void {
		const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
		const chunk = Object.freeze({
			sequence: this.#sequence += 1,
			stream,
			data: Uint8Array.from(bytes),
		});
		if (!this.#hasOutputSubscriber || this.#outputReplayScheduled) {
			this.#pendingOutput.push(chunk);
			return;
		}
		for (const listener of this.#outputListeners) listener(chunk);
	}

	#scheduleOutputReplay(): void {
		if (this.#outputReplayScheduled) return;
		this.#outputReplayScheduled = true;
		queueMicrotask(() => {
			this.#outputReplayScheduled = false;
			const pending = this.#pendingOutput;
			this.#pendingOutput = [];
			for (const chunk of pending) {
				for (const listener of this.#outputListeners) listener(chunk);
			}
		});
	}
}

function validateRequest(request: ShellTransportStartRequest): void {
	if (!request.executable.trim()) {
		throw new RangeError("pipe transport requires an executable");
	}
	if (!request.cwd.trim()) {
		throw new RangeError("pipe transport requires a cwd");
	}
	if (request.tty) {
		throw new RangeError("pipe transport does not support tty mode");
	}
	if (!Number.isSafeInteger(request.rows) || request.rows <= 0
		|| !Number.isSafeInteger(request.columns) || request.columns <= 0) {
		throw new RangeError("terminal dimensions must be positive safe integers");
	}
}

function shellSpawnFailure(): Error {
	return new Error("shell_spawn_failed: unable to start pipe process");
}
