import { isDeepStrictEqual } from "node:util";
import { PluginHostError } from "./process-host.ts";
import type { PluginHostContract, PluginHostFailure, PluginHostStatus, PluginInvocationResult, PluginProtocolRegistration } from "./types.ts";

const RECOVERABLE_FAILURES = new Set(["call_timeout", "startup_timeout", "worker_exited", "host_closed"]);

export class RecoverablePluginHost implements PluginHostContract {
	readonly #createHost: () => PluginHostContract;
	readonly #listeners = new Set<() => void>();
	#host: PluginHostContract;
	#unsubscribe?: () => void;
	#registrations?: readonly PluginProtocolRegistration[];
	#failure?: PluginHostFailure;
	#closed = false;
	#recovery?: Promise<void>;
	#recoveryController?: AbortController;
	#waiters = 0;
	#closePromise?: Promise<void>;
	#publishedStatus: PluginHostStatus = "idle";
	#publishedFailure?: PluginHostFailure;

	constructor(createHost: () => PluginHostContract) {
		this.#createHost = createHost;
		this.#host = createHost();
		this.#observe();
	}

	get status(): PluginHostStatus { return this.#closed ? "closed" : this.#recovery ? "starting" : this.#failure ? "failed" : this.#host.status; }
	get failure(): PluginHostFailure | undefined { return this.#failure ?? this.#host.failure; }
	get registrations(): readonly PluginProtocolRegistration[] { return this.#registrations ?? this.#host.registrations; }

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => { this.#listeners.delete(listener); };
	}

	async start(signal: AbortSignal): Promise<readonly PluginProtocolRegistration[]> {
		this.#assertOpen(signal);
		this.#registrations ??= await this.#host.start(signal);
		return this.#registrations;
	}

	async invoke(target: string, input: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<PluginInvocationResult> {
		this.#assertOpen(signal);
		await this.start(signal);
		if (this.status === "failed" || this.#recovery) {
			if (!this.#recovery && (!this.failure || !RECOVERABLE_FAILURES.has(this.failure.kind))) {
				throw new PluginHostError("host_closed", { phase: "connect", dispatched: false, previous: this.failure });
			}
			await this.#recover(signal);
		}
		this.#assertOpen(signal);
		// A new invocation may use a replacement process; never replay an in-flight call.
		try { return await this.#host.invoke(target, input, signal); }
		finally { this.#notify(); }
	}

	close(): Promise<void> {
		if (!this.#closePromise) {
			this.#closed = true;
			this.#recoveryController?.abort();
			this.#unsubscribe?.();
			this.#closePromise = (async () => {
				await this.#recovery?.catch(() => undefined);
				await this.#host.close();
			})();
			this.#notify();
			this.#listeners.clear();
		}
		return this.#closePromise;
	}

	async #recover(signal: AbortSignal): Promise<void> {
		if (this.#recoveryController?.signal.aborted && this.#recovery) {
			await withSignal(this.#recovery.catch(() => undefined), signal);
			this.#assertOpen(signal);
		}
		this.#waiters += 1;
		try {
			if (!this.#recovery) {
				const controller = new AbortController();
				this.#recoveryController = controller;
				this.#recovery = this.#replace(controller.signal).finally(() => { this.#recovery = undefined; this.#notify(); });
				this.#notify();
			}
			await withSignal(this.#recovery, signal);
		} finally {
			this.#waiters -= 1;
			if (this.#waiters === 0 && this.#recovery) this.#recoveryController?.abort();
		}
	}

	async #replace(signal: AbortSignal): Promise<void> {
		const previous = this.failure;
		try {
			await this.#host.close();
			this.#assertOpen(signal);
			this.#unsubscribe?.();
			this.#host = this.#createHost();
			this.#observe();
			const registrations = await this.#host.start(signal);
			this.#assertOpen(signal);
			const ordered = (items: readonly PluginProtocolRegistration[]): readonly PluginProtocolRegistration[] =>
				[...items].sort((left, right) => left.token.localeCompare(right.token, "en"));
			if (!isDeepStrictEqual(ordered(registrations), ordered(this.#registrations ?? []))) {
				throw new PluginHostError("registration_mismatch");
			}
			this.#failure = undefined;
		} catch (error) {
			await this.#host.close().catch(() => undefined);
			this.#failure = new PluginHostError(signal.aborted ? "host_closed" : error instanceof PluginHostError ? error.kind : "plugin_error", {
				...(error instanceof PluginHostError ? error.evidence : {}), phase: "reconnect", dispatched: false, recoveryAttempts: 1, previous,
			});
			if (signal.aborted || this.#closed) throw new DOMException("interrupted", "AbortError");
			throw this.#failure;
		} finally { this.#notify(); }
	}

	#observe(): void {
		this.#unsubscribe = this.#host.subscribe?.(() => this.#notify());
	}

	#notify(): void {
		const status = this.status;
		const failure = this.failure;
		if (status === this.#publishedStatus && failure === this.#publishedFailure) return;
		this.#publishedStatus = status;
		this.#publishedFailure = failure;
		for (const listener of this.#listeners) {
			try { listener(); } catch { /* Observers cannot affect plugin execution. */ }
		}
	}

	#assertOpen(signal: AbortSignal): void {
		signal.throwIfAborted();
		if (this.#closed) throw new PluginHostError("host_closed", { phase: "connect", dispatched: false, previous: this.failure });
	}
}

function withSignal<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
	return new Promise((resolve, reject) => {
		const aborted = (): void => { reject(signal.reason); };
		if (signal.aborted) aborted();
		else signal.addEventListener("abort", aborted, { once: true });
		void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
	});
}
