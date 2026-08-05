import type {
	ProcessCleanupResult,
	ShellExit,
	ShellOutputChunk,
	ShellTransport,
	ShellTransportStartRequest,
} from "../../src/index.ts";

export class FakeShellTransport implements ShellTransport {
	readonly kind;
	readonly tty;
	readonly pid;
	readonly writes: string[] = [];
	readonly resizes: Array<{ readonly rows: number; readonly columns: number }> = [];
	interruptCalls = 0;
	terminateCalls = 0;
	closeCalls = 0;
	readonly #outputListeners = new Set<(chunk: ShellOutputChunk) => void>();
	readonly #exitListeners = new Set<(exit: ShellExit) => void>();
	#exit: ShellExit | undefined;
	#closed = false;

	constructor(options: {
		readonly kind?: ShellTransport["kind"];
		readonly pid?: number;
	} = {}) {
		this.kind = options.kind ?? "unix_pty";
		this.tty = this.kind !== "pipe";
		this.pid = options.pid ?? 4321;
	}

	onOutput(listener: (chunk: ShellOutputChunk) => void): () => void {
		this.#outputListeners.add(listener);
		return () => this.#outputListeners.delete(listener);
	}

	onExit(listener: (exit: ShellExit) => void): () => void {
		this.#exitListeners.add(listener);
		if (this.#exit !== undefined) listener(this.#exit);
		return () => this.#exitListeners.delete(listener);
	}

	async write(text: string): Promise<void> {
		this.writes.push(text);
	}

	async resize(rows: number, columns: number): Promise<void> {
		this.resizes.push({ rows, columns });
	}

	async interrupt(): Promise<ProcessCleanupResult> {
		this.interruptCalls += 1;
		return { state: "interrupted", signal: "SIGINT" };
	}

	async terminate(): Promise<ProcessCleanupResult> {
		this.terminateCalls += 1;
		return { state: "terminated", signal: "SIGTERM" };
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.closeCalls += 1;
		this.#outputListeners.clear();
		this.#exitListeners.clear();
	}

	emitOutput(chunk: ShellOutputChunk): void {
		for (const listener of this.#outputListeners) listener(chunk);
	}

	emitExit(exit: ShellExit): void {
		if (this.#exit !== undefined) return;
		this.#exit = Object.freeze({ ...exit });
		for (const listener of this.#exitListeners) listener(this.#exit);
	}
}

export class FakeShellTransportFactory {
	started = 0;
	lastRequest: ShellTransportStartRequest | undefined;
	readonly transports: FakeShellTransport[] = [];

	readonly create = async (
		request: ShellTransportStartRequest,
	): Promise<FakeShellTransport> => {
		this.started += 1;
		this.lastRequest = request;
		const transport = new FakeShellTransport({
			kind: request.tty ? "unix_pty" : "pipe",
			pid: 4_000 + this.started,
		});
		this.transports.push(transport);
		return transport;
	};
}
