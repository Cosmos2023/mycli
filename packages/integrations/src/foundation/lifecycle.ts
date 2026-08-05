export interface IntegrationLifecycle {
	close(signal?: AbortSignal): Promise<void>;
}

export interface IntegrationLifecycleStackOptions {
	readonly closeTimeoutMs: number;
}

export class IntegrationLifecycleStack implements IntegrationLifecycle {
	readonly #closeTimeoutMs: number;
	readonly #lifecycles: IntegrationLifecycle[] = [];
	#closePromise?: Promise<void>;

	constructor(options: IntegrationLifecycleStackOptions) {
		if (!Number.isSafeInteger(options.closeTimeoutMs)
			|| options.closeTimeoutMs <= 0
			|| options.closeTimeoutMs > 60_000) {
			throw new Error("invalid_integration_close_timeout");
		}
		this.#closeTimeoutMs = options.closeTimeoutMs;
	}

	add(lifecycle: IntegrationLifecycle): void {
		if (this.#closePromise) throw new Error("integration_lifecycle_closed");
		this.#lifecycles.push(lifecycle);
	}

	close(signal?: AbortSignal): Promise<void> {
		this.#closePromise ??= this.#closeAll(signal);
		return this.#closePromise;
	}

	async #closeAll(signal?: AbortSignal): Promise<void> {
		let failed = false;
		for (const lifecycle of [...this.#lifecycles].reverse()) {
			try {
				await closeWithin(lifecycle, this.#closeTimeoutMs, signal);
			} catch {
				failed = true;
			}
		}
		this.#lifecycles.length = 0;
		if (failed) throw new Error("integration_close_failed");
	}
}

function closeWithin(
	lifecycle: IntegrationLifecycle,
	timeoutMs: number,
	callerSignal?: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const controller = new AbortController();
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			callerSignal?.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = (): void => {
			controller.abort();
			finish(() => reject(new Error("integration_close_interrupted")));
		};
		const timeout = setTimeout(() => {
			controller.abort();
			finish(() => reject(new Error("integration_close_timeout")));
		}, timeoutMs);
		callerSignal?.addEventListener("abort", onAbort, { once: true });
		if (callerSignal?.aborted) {
			onAbort();
			return;
		}
		Promise.resolve(lifecycle.close(controller.signal)).then(
			() => finish(resolve),
			() => finish(() => reject(new Error("integration_close_error"))),
		);
	});
}
