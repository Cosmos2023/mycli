/** The execution budget excludes time spent waiting for explicit user input. */
export class McpRequestDeadline {
	readonly #controller = new AbortController();
	readonly signal: AbortSignal;
	#remaining: number;
	#started = 0;
	#pauses = 0;
	#timer?: ReturnType<typeof setTimeout>;
	#disposed = false;
	constructor(parent: AbortSignal, timeoutMs: number) {
		this.signal = AbortSignal.any([parent, this.#controller.signal]);
		this.#remaining = timeoutMs;
		this.#start();
	}
	readonly pause = (): (() => void) => {
		if (!this.#pauses++) {
			clearTimeout(this.#timer);
			this.#remaining -= performance.now() - this.#started;
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (!--this.#pauses) this.#start();
		};
	};
	dispose(): void { this.#disposed = true; clearTimeout(this.#timer); }
	#start(): void {
		if (this.#disposed || this.signal.aborted) return;
		this.#started = performance.now();
		this.#timer = setTimeout(() => this.#controller.abort(new DOMException("MCP request timed out", "TimeoutError")), Math.max(0, this.#remaining));
		this.#timer.unref();
	}
}
