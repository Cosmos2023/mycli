interface RefreshableNodeRuntime {
	refreshExtensions?(): void;
	closeExtensions?(): Promise<void>;
}

export class NodeRuntimeRegistry<Runtime extends RefreshableNodeRuntime> {
	readonly #runtimeBySessionId = new Map<string, Runtime>();
	readonly #preparing = new Map<string, Promise<Runtime>>();
	readonly #controller = new AbortController();
	#closing: Promise<void> | undefined;

	get(sessionId: string): Runtime | undefined {
		return this.#runtimeBySessionId.get(sessionId);
	}

	set(sessionId: string, runtime: Runtime): void {
		this.#controller.signal.throwIfAborted();
		if (!sessionId.trim()) throw new TypeError("runtime session id must be non-empty");
		this.#runtimeBySessionId.set(sessionId, runtime);
	}

	getOrCreate(sessionId: string, create: (signal: AbortSignal) => Promise<Runtime>): Promise<Runtime> {
		if (!sessionId.trim()) return Promise.reject(new TypeError("runtime session id must be non-empty"));
		if (this.#controller.signal.aborted) return Promise.reject(this.#controller.signal.reason);
		const current = this.get(sessionId);
		if (current) return Promise.resolve(current);
		const pending = this.#preparing.get(sessionId);
		if (pending) return pending;
		const task = Promise.resolve().then(() => {
			this.#controller.signal.throwIfAborted();
			return create(this.#controller.signal);
		}).then(async (runtime) => {
			if (this.#controller.signal.aborted || this.get(sessionId)) {
				await runtime.closeExtensions?.();
				this.#controller.signal.throwIfAborted();
				return this.get(sessionId)!;
			}
			this.set(sessionId, runtime);
			return runtime;
		}).finally(() => { this.#preparing.delete(sessionId); });
		this.#preparing.set(sessionId, task);
		return task;
	}

	async dispose(sessionId: string, expected: Runtime): Promise<void> {
		this.delete(sessionId, expected);
		await expected.closeExtensions?.();
	}

	stop(): void {
		this.#controller.abort();
	}

	close(): Promise<void> {
		this.stop();
		return this.#closing ??= (async () => {
			await Promise.allSettled(this.#preparing.values());
			const closed = await Promise.allSettled([...this.#runtimeBySessionId].map(
				([sessionId, runtime]) => this.dispose(sessionId, runtime),
			));
			for (const result of closed) if (result.status === "rejected") throw result.reason;
		})();
	}

	delete(sessionId: string, expected: Runtime): boolean {
		if (this.#runtimeBySessionId.get(sessionId) !== expected) return false;
		return this.#runtimeBySessionId.delete(sessionId);
	}

	refreshExtensions(): void {
		for (const runtime of [...this.#runtimeBySessionId.values()]) {
			runtime.refreshExtensions?.();
		}
	}
}
