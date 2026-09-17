import { ProviderFailure } from "../errors.ts";

export const PI_AI_STREAM_MAX_EVENTS = 64;
export const PI_AI_STREAM_MAX_BYTES = 8 * 1_024 * 1_024;

export function streamBufferFailure(): ProviderFailure {
	return new ProviderFailure({
		code: "response_stream_error",
		message: "provider stream exceeded the pending event limit",
		publicDetail: "Response stream exceeded its buffering limit.",
	});
}

// Both SDK delivery and SSE acknowledgement wait for downstream consumption.
// A synchronous native-event burst must either fit in full or fail explicitly.
export class PiAiStreamQueue<T> {
	readonly #items: { readonly event: T; readonly bytes: number }[] = [];
	readonly #waiters = new Set<() => void>();
	readonly #stopListeners = new Set<() => void>();
	#bytes = 0;
	#closed = false;
	#failure: { readonly error: unknown } | undefined;

	get closed(): boolean { return this.#closed; }

	waitForNext<R>(next: Promise<R>): Promise<R | undefined> {
		if (this.#closed) {
			void next.catch(() => undefined);
			return Promise.resolve(undefined);
		}
		return new Promise<R | undefined>((resolve, reject) => {
			const stop = (): void => resolve(undefined);
			this.#stopListeners.add(stop);
			void next.then((result) => {
				this.#stopListeners.delete(stop);
				resolve(result);
			}, (error: unknown) => {
				this.#stopListeners.delete(stop);
				reject(error);
			});
		});
	}

	push(event: T): void {
		if (this.#closed) return;
		const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
		if (this.#items.length >= PI_AI_STREAM_MAX_EVENTS || this.#bytes + bytes > PI_AI_STREAM_MAX_BYTES) {
			const error = streamBufferFailure();
			this.fail(error);
			throw error;
		}
		this.#items.push({ event, bytes });
		this.#bytes += bytes;
		this.#notify();
	}

	async drained(): Promise<void> {
		while (this.#items.length > 0 && !this.#closed) await this.#changed();
	}

	async take(): Promise<IteratorResult<T>> {
		while (this.#items.length === 0 && !this.#closed) await this.#changed();
		if (this.#failure) throw this.#failure.error;
		const item = this.#items.shift();
		if (!item) return { done: true, value: undefined };
		this.#bytes -= item.bytes;
		this.#notify();
		return { done: false, value: item.event };
	}

	close(): void {
		this.#closed = true;
		for (const resolve of this.#stopListeners) resolve();
		this.#stopListeners.clear();
		this.#notify();
	}

	stop(): void {
		this.#items.length = 0;
		this.#bytes = 0;
		this.close();
	}

	fail(error: unknown): void {
		if (this.#closed) return;
		this.#failure = { error };
		this.stop();
	}

	#changed(): Promise<void> {
		return new Promise((resolve) => this.#waiters.add(resolve));
	}

	#notify(): void {
		for (const resolve of this.#waiters) resolve();
		this.#waiters.clear();
	}
}
