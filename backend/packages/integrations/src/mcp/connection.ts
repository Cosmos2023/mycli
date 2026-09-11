import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { classifyMcpFailure, isMcpAbort, McpHttpError, McpRequestError, type McpOperation } from "./diagnostics.ts";
import type { McpProtocolClient, McpTransportKind } from "./types.ts";

interface ConnectionState {
	readonly protocol: McpProtocolClient;
	readonly controller: AbortController;
	users: number;
	connected: boolean;
	retired: boolean;
	connectPromise?: Promise<void>;
	closePromise?: Promise<void>;
}

interface McpConnectionOptions {
	readonly createProtocol: () => McpProtocolClient;
	readonly transport: McpTransportKind;
	readonly timeoutMs: number;
	readonly recoverSession: boolean;
}

export class McpConnection {
	readonly #options: McpConnectionOptions;
	readonly #states = new Set<ConnectionState>();
	#current?: ConnectionState;
	#closed = false;
	#closePromise?: Promise<void>;

	constructor(options: McpConnectionOptions) {
		this.#options = options;
		this.#current = this.#createState();
	}

	async run<Value>(
		operation: McpOperation,
		signal: AbortSignal,
		request: (protocol: McpProtocolClient, signal: AbortSignal) => Promise<Value>,
	): Promise<Value> {
		for (let attempt: 0 | 1 = 0; ; attempt = 1) {
			if (signal.aborted) throw abortError();
			if (this.#closed) throw new McpRequestError(new Error("mcp_client_closed"), { operation, phase: "connect" });
			const state = this.#current ??= this.#createState();
			state.users += 1;
			const activeSignal = AbortSignal.any([signal, state.controller.signal]);
			let phase: "connect" | "reconnect" | "request" = attempt === 0 ? "connect" : "reconnect";
			try {
				await withSignal(this.#connect(state), activeSignal);
				activeSignal.throwIfAborted();
				phase = "request";
				const value = await request(state.protocol, activeSignal);
				activeSignal.throwIfAborted();
				return value;
			} catch (error) {
				if (signal.aborted || this.#closed || isMcpAbort(error)) {
					if (this.#options.transport === "stdio") await this.close().catch(() => undefined);
					throw abortError();
				}
				const sessionExpired = phase === "request" && error instanceof McpHttpError && error.sessionExpired;
				if (phase !== "request" || sessionExpired || (error instanceof McpError && error.code === ErrorCode.ConnectionClosed)) {
					this.#retire(state);
				}
				if (sessionExpired && this.#options.recoverSession && attempt === 0) continue;
				if (this.#options.transport === "stdio" && classifyMcpFailure(error) === "timeout") {
					await this.close().catch(() => undefined);
				}
				throw new McpRequestError(error, { operation: phase === "request" ? operation : "initialize", phase,
					timeoutMs: this.#options.timeoutMs, recoveryAttempts: attempt });
			} finally {
				state.users -= 1;
				if (state.users === 0 && (state.retired || !state.connected)) {
					this.#retire(state);
					const cleanup = this.#closeState(state).catch(() => undefined);
					if (!state.connected) await cleanup;
				}
			}
		}
	}

	close(): Promise<void> {
		if (!this.#closePromise) {
			this.#closed = true;
			this.#closePromise = this.#closeAll();
		}
		return this.#closePromise;
	}

	#createState(): ConnectionState {
		const state: ConnectionState = { protocol: this.#options.createProtocol(), controller: new AbortController(),
			users: 0, connected: false, retired: false };
		this.#states.add(state);
		return state;
	}

	#connect(state: ConnectionState): Promise<void> {
		state.connectPromise ??= withSignal(state.protocol.connect(state.controller.signal),
			AbortSignal.any([state.controller.signal, AbortSignal.timeout(this.#options.timeoutMs)]))
			.then(() => { state.controller.signal.throwIfAborted(); state.connected = true; });
		return state.connectPromise;
	}

	#retire(state: ConnectionState): void {
		state.retired = true;
		// Other requests may still have a valid response in flight on this generation.
		if (this.#current === state) this.#current = undefined;
	}

	#closeState(state: ConnectionState): Promise<void> {
		if (!state.closePromise) {
			state.controller.abort();
			state.closePromise = Promise.resolve().then(() => state.protocol.close()).finally(() => this.#states.delete(state));
		}
		return state.closePromise;
	}

	async #closeAll(): Promise<void> {
		const results = await Promise.allSettled([...this.#states].map((state) => this.#closeState(state)));
		const failed = results.find((result) => result.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
	}
}

function withSignal<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
	return new Promise<Value>((resolve, reject) => {
		const aborted = (): void => { reject(signal.reason); };
		if (signal.aborted) aborted();
		else signal.addEventListener("abort", aborted, { once: true });
		void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
	});
}

function abortError(): Error { return new DOMException("interrupted", "AbortError"); }
