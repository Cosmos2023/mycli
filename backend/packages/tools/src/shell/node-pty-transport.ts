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
	type ShellTransport,
	type ShellTransportStartRequest,
} from "./shell-transport.ts";

const DEFAULT_TERMINAL_NAME = "xterm-256color";

interface Disposable {
	dispose(): void;
}

interface NodePtyProcess {
	readonly pid: number;
	onData(listener: (data: string) => void): Disposable;
	onExit(listener: (event: { readonly exitCode: number; readonly signal?: number }) => void): Disposable;
	write(text: string): void;
	resize(columns: number, rows: number): void;
	kill(signal?: string): void;
}

interface NodePtyModule {
	spawn(
		executable: string,
		args: string[],
		options: {
			readonly name: string;
			readonly cols: number;
			readonly rows: number;
			readonly cwd: string;
			readonly env: NodeJS.ProcessEnv;
		},
	): NodePtyProcess;
}

export interface StartNodePtyTransportOptions {
	readonly loadNodePty?: () => Promise<NodePtyModule>;
	readonly processController?: ProcessControllerOptions;
}

export async function startNodePtyTransport(
	request: ShellTransportStartRequest,
	options: StartNodePtyTransportOptions = {},
): Promise<ShellTransport> {
	validateRequest(request);
	let nodePty: NodePtyModule;
	try {
		nodePty = options.loadNodePty
			? await options.loadNodePty()
			: await import("node-pty");
	} catch {
		throw unavailableForPlatform(request.platform);
	}

	let process: NodePtyProcess;
	try {
		process = nodePty.spawn(request.executable, [...request.args], {
			name: request.name ?? request.env.TERM ?? DEFAULT_TERMINAL_NAME,
			cols: request.columns,
			rows: request.rows,
			cwd: request.cwd,
			env: { ...request.env },
		});
	} catch {
		throw unavailableForPlatform(request.platform);
	}
	if (!Number.isSafeInteger(process.pid) || process.pid <= 0) {
		throw unavailableForPlatform(request.platform);
	}
	return new NodePtyTransport(process, request.platform, options.processController);
}

class NodePtyTransport implements ShellTransport {
	readonly kind: "unix_pty" | "windows_conpty";
	readonly tty = true;
	readonly pid: number;
	readonly #process: NodePtyProcess;
	readonly #controller: ProcessController;
	readonly #outputListeners = new Set<(chunk: ShellOutputChunk) => void>();
	readonly #exitListeners = new Set<(exit: ShellExit) => void>();
	readonly #dataSubscription: Disposable;
	readonly #exitSubscription: Disposable;
	#pendingOutput: ShellOutputChunk[] = [];
	#outputReplayScheduled = false;
	#hasOutputSubscriber = false;
	#sequence = 0;
	#exit: ShellExit | undefined;
	readonly #managedState = { exitCode: null as number | null };
	#closed = false;

	constructor(
		process: NodePtyProcess,
		platform: NodeJS.Platform,
		processController: ProcessControllerOptions | undefined,
	) {
		this.kind = platform === "win32" ? "windows_conpty" : "unix_pty";
		this.pid = process.pid;
		this.#process = process;
		const managedState = this.#managedState;
		this.#controller = createProcessController({
			pid: process.pid,
			get exitCode() {
				return managedState.exitCode;
			},
			signalCode: null,
			kill: (signal) => {
				if (platform === "win32" && signal === "SIGBREAK") {
					process.write("\u0003");
				} else {
					process.kill(typeof signal === "number" ? String(signal) : signal);
				}
				return true;
			},
		}, {
			...processController,
			platform,
		});
		this.#dataSubscription = process.onData(this.#onData);
		this.#exitSubscription = process.onExit(this.#onExit);
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
		if (this.#closed || this.#exit !== undefined) {
			throw new ShellTransportError("stdin_closed", "Shell terminal input is closed.");
		}
		try {
			this.#process.write(text);
		} catch {
			throw new ShellTransportError("shell_write_failed", "Unable to write to shell terminal.");
		}
	}

	async resize(rows: number, columns: number): Promise<void> {
		validateDimensions(rows, columns);
		if (this.#closed || this.#exit !== undefined) {
			throw new ShellTransportError("shell_resize_failed", "Shell terminal is closed.");
		}
		try {
			this.#process.resize(columns, rows);
		} catch {
			throw new ShellTransportError("shell_resize_failed", "Unable to resize shell terminal.");
		}
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
		this.#dataSubscription.dispose();
		this.#exitSubscription.dispose();
		this.#pendingOutput = [];
		this.#outputListeners.clear();
		this.#exitListeners.clear();
	}

	readonly #onData = (data: string): void => {
		if (this.#closed) return;
		const chunk = Object.freeze({
			sequence: this.#sequence += 1,
			stream: "terminal" as const,
			data,
		});
		if (!this.#hasOutputSubscriber || this.#outputReplayScheduled) {
			this.#pendingOutput.push(chunk);
			return;
		}
		for (const listener of this.#outputListeners) listener(chunk);
	};

	readonly #onExit = (event: { readonly exitCode: number; readonly signal?: number }): void => {
		if (this.#closed || this.#exit !== undefined) return;
		this.#managedState.exitCode = event.exitCode;
		const exit = Object.freeze({
			exitCode: event.exitCode,
			signal: event.signal === undefined || event.signal === 0 ? null : String(event.signal),
		});
		this.#exit = exit;
		for (const listener of this.#exitListeners) listener(exit);
	};

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
	if (!request.executable.trim()) throw new RangeError("PTY transport requires an executable");
	if (!request.cwd.trim()) throw new RangeError("PTY transport requires a cwd");
	if (!request.tty) throw new RangeError("PTY transport requires tty mode");
	validateDimensions(request.rows, request.columns);
}

function validateDimensions(rows: number, columns: number): void {
	if (!Number.isSafeInteger(rows) || rows <= 0
		|| !Number.isSafeInteger(columns) || columns <= 0) {
		throw new RangeError("terminal dimensions must be positive safe integers");
	}
}

function unavailableForPlatform(platform: NodeJS.Platform): ShellTransportError {
	return platform === "win32"
		? new ShellTransportError("conpty_unavailable", "Windows ConPTY is unavailable.")
		: new ShellTransportError("pty_unavailable", "Unix PTY is unavailable.");
}
