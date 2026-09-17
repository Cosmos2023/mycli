interface PendingOperation<Value> {
	readonly controller: AbortController;
	readonly promise: Promise<Value>;
	waiters: number;
}

/** Coalesce concurrent discovery without giving one caller ownership of other callers. */
export class SharedMcpOperation<Value> {
	#pending?: PendingOperation<Value>;
	#closed = false;

	run(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<Value>): Promise<Value> {
		if (this.#closed) return Promise.reject(new Error("mcp_manager_closed"));
		if (signal.aborted) return Promise.reject(signal.reason);
		if (this.#pending?.controller.signal.aborted) {
			return waitForMcpOperation(this.#pending.promise.catch(() => undefined), signal)
				.then(() => this.run(signal, operation));
		}
		if (!this.#pending) {
			const controller = new AbortController();
			const promise = Promise.resolve().then(async () => {
				controller.signal.throwIfAborted();
				const value = await operation(controller.signal);
				controller.signal.throwIfAborted();
				return value;
			});
			const pending = { controller, promise, waiters: 0 };
			this.#pending = pending;
			const finished = (): void => { if (this.#pending === pending) this.#pending = undefined; };
			void promise.then(finished, finished);
		}
		const pending = this.#pending;
		pending.waiters += 1;
		return waitForMcpOperation(pending.promise, signal).finally(() => {
			pending.waiters -= 1;
			if (pending.waiters === 0 && this.#pending === pending) pending.controller.abort();
		});
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#pending?.controller.abort();
		await this.#pending?.promise.catch(() => undefined);
	}
}

export function waitForMcpOperation<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
	return new Promise<Value>((resolve, reject) => {
		const aborted = (): void => { reject(signal.reason); };
		if (signal.aborted) aborted();
		else signal.addEventListener("abort", aborted, { once: true });
		void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
	});
}
