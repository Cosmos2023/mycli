import { PassThrough } from "node:stream";
import { Worker } from "node:worker_threads";
import type { NodeBackend, StartNodeBackendOptions } from "./node-backend.ts";

type JsonObject = Record<string, unknown>;
type RpcId = string | number | null;

interface SupervisedNodeBackendOptions extends StartNodeBackendOptions {
	readonly hardInterruptTimeoutMs?: number;
	readonly workerUrl?: URL;
}

interface PendingRequest {
	readonly id: RpcId;
	readonly generation: number;
	readonly method: string;
}

interface PendingInterrupt extends PendingRequest {
	readonly sessionId: string;
	readonly turnId: string;
	readonly timer: NodeJS.Timeout;
}

interface ActiveTurnIdentity {
	readonly clientTurnId: string;
	readonly turnId: string;
}

const DEFAULT_HARD_INTERRUPT_TIMEOUT_MS = 250;
const CLOSE_TIMEOUT_MS = 500;

export async function startSupervisedNodeBackend(
	options: SupervisedNodeBackendOptions,
): Promise<NodeBackend> {
	const supervisor = new WorkerNodeBackendSupervisor(options);
	await supervisor.start();
	return supervisor;
}

class WorkerNodeBackendSupervisor implements NodeBackend {
	readonly transport;
	readonly completion: Promise<number>;
	readonly #clientInput = new PassThrough();
	readonly #clientOutput = new PassThrough();
	readonly #options: StartNodeBackendOptions;
	readonly #workerUrl: URL;
	readonly #hardInterruptTimeoutMs: number;
	readonly #resolveCompletion: (code: number) => void;
	readonly #pendingRequests = new Map<string, PendingRequest>();
	readonly #pendingInterrupts = new Map<string, PendingInterrupt>();
	#worker: Worker | null = null;
	#generation = 0;
	#closed = false;
	#completionResolved = false;
	#restarting = false;
	#queuedInput: string[] = [];
	#clientLineBuffer = "";
	#workerLineBuffer = "";
	#publishedInterrupts = new Set<string>();
	#sessionId: string | undefined;
	#model: string | undefined;
	#activeTurn: ActiveTurnIdentity | undefined;
	#diagnostic = "";

	constructor(options: SupervisedNodeBackendOptions) {
		this.#options = {
			cwd: options.cwd,
			env: { ...options.env },
			args: [...options.args],
			...(options.maxOutputTokens === undefined
				? {}
				: { maxOutputTokens: options.maxOutputTokens }),
		};
		this.#workerUrl = options.workerUrl
			?? new URL(
				`./node-backend-worker${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
				import.meta.url,
			);
		this.#hardInterruptTimeoutMs = options.hardInterruptTimeoutMs
			?? DEFAULT_HARD_INTERRUPT_TIMEOUT_MS;
		this.#sessionId = flagValue(options.args, "--session");
		this.#model = flagValue(options.args, "--model");
		let resolveCompletion!: (code: number) => void;
		this.completion = new Promise<number>((resolve) => { resolveCompletion = resolve; });
		this.#resolveCompletion = resolveCompletion;
		this.transport = {
			input: this.#clientInput,
			output: this.#clientOutput,
			close: () => this.close(),
		};
		this.#clientOutput.on("data", (chunk: Buffer | string) => {
			this.#handleClientChunk(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
		});
	}

	async start(): Promise<void> {
		await this.#spawn(this.#options);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearInterrupts();
		const worker = this.#worker;
		this.#worker = null;
		if (worker) {
			worker.postMessage({ type: "close" });
			const closed = await settlesWithin(waitForExit(worker), CLOSE_TIMEOUT_MS);
			if (!closed) await worker.terminate();
		}
		this.#clientInput.end();
		this.#clientOutput.end();
		this.#resolveOnce(0);
	}

	kill(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearInterrupts();
		const worker = this.#worker;
		this.#worker = null;
		void worker?.terminate();
		this.#clientInput.destroy();
		this.#clientOutput.destroy();
		this.#resolveOnce(1);
	}

	diagnostic(): string {
		return this.#diagnostic;
	}

	#handleClientChunk(chunk: string): void {
		this.#clientLineBuffer += chunk;
		let newline = this.#clientLineBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.#clientLineBuffer.slice(0, newline);
			this.#clientLineBuffer = this.#clientLineBuffer.slice(newline + 1);
			this.#trackClientRequest(line);
			newline = this.#clientLineBuffer.indexOf("\n");
		}
		if (this.#restarting || !this.#worker) {
			this.#queuedInput.push(chunk);
			return;
		}
		this.#worker.postMessage({ type: "input", chunk });
	}

	#trackClientRequest(line: string): void {
		const request = parseJsonObject(line);
		if (!request || !(typeof request.id === "string" || typeof request.id === "number")) return;
		if (typeof request.method !== "string") return;
		const pending: PendingRequest = {
			id: request.id,
			generation: this.#worker ? this.#generation : this.#generation + 1,
			method: request.method,
		};
		const key = rpcKey(request.id);
		this.#pendingRequests.set(key, pending);
		if (request.method !== "turn.interrupt" || !isObject(request.params)) return;
		const turnId = stringValue(request.params.turn_id);
		const sessionId = this.#sessionId;
		if (!turnId || !sessionId) return;
		const timer = setTimeout(() => {
			void this.#hardInterrupt(turnId);
		}, this.#hardInterruptTimeoutMs);
		timer.unref();
		this.#pendingInterrupts.set(key, { ...pending, sessionId, turnId, timer });
	}

	async #hardInterrupt(turnId: string): Promise<void> {
		if (this.#closed || this.#restarting) return;
		const matching = [...this.#pendingInterrupts.entries()]
			.filter(([, pending]) => pending.turnId === turnId);
		if (matching.length === 0) return;
		this.#restarting = true;
		for (const [, pending] of matching) clearTimeout(pending.timer);
		const sessionId = matching[0]![1].sessionId;
		const clientTurnId = this.#activeTurn?.clientTurnId ?? turnId;
		const staleGeneration = this.#generation;
		const staleRequests = [...this.#pendingRequests.entries()]
			.filter(([, request]) => request.generation === staleGeneration);
		const staleWorker = this.#worker;
		this.#worker = null;
		try {
			if (staleWorker) await staleWorker.terminate();
			if (this.#closed) return;
			const args = withFlag(
				this.#model ? withFlag(this.#options.args, "--model", this.#model) : this.#options.args,
				"--session",
				sessionId,
			);
			const publishedInterrupts = await this.#spawn({
				...this.#options,
				args,
				recoverInterruptedTurns: [{
					sessionId,
					turnId,
					inputRolledBack: false,
					userInitiated: true,
				}],
			});
			if (!publishedInterrupts.has(interruptKey(sessionId, turnId))) {
				throw new Error("interrupted_turn_recovery_not_published");
			}
			for (const [key, pending] of matching) {
				this.#pendingInterrupts.delete(key);
				this.#pendingRequests.delete(key);
				this.#writeResult(pending.id, {
					accepted: true,
					requested: true,
					client_turn_id: clientTurnId,
					turn_id: turnId,
					input_rolled_back: false,
				});
			}
			for (const [key, pending] of staleRequests) {
				if (!this.#pendingRequests.has(key)) continue;
				this.#pendingRequests.delete(key);
				this.#writeError(
					pending.id,
					"internal_error",
					"Backend restarted while the request was running.",
				);
			}
			this.#activeTurn = undefined;
		} catch {
			this.#diagnostic = "node_backend_worker_restart_failed";
			this.#terminateCurrentWorker();
			for (const [key, pending] of matching) {
				this.#pendingInterrupts.delete(key);
				this.#pendingRequests.delete(key);
				this.#writeError(pending.id, "internal_error", "Unable to restart interrupted backend.");
			}
			this.#resolveOnce(1);
		} finally {
			this.#restarting = false;
			this.#flushQueuedInput();
		}
	}

	async #spawn(options: StartNodeBackendOptions): Promise<ReadonlySet<string>> {
		const generation = ++this.#generation;
		this.#workerLineBuffer = "";
		this.#publishedInterrupts = new Set<string>();
		const worker = new Worker(this.#workerUrl, {
			workerData: { generation, options },
		});
		this.#worker = worker;
		await new Promise<void>((resolve, reject) => {
			let started = false;
			worker.on("message", (message: unknown) => {
				if (worker !== this.#worker || !isObject(message) || message.generation !== generation) return;
				if (message.type === "output" && typeof message.chunk === "string") {
					this.#handleWorkerChunk(message.chunk);
					return;
				}
				if (message.type === "started") {
					started = true;
					resolve();
					return;
				}
				if (message.type === "completion" && typeof message.code === "number") {
					if (!this.#restarting) this.#resolveOnce(message.code);
					return;
				}
				if (message.type === "start_error") {
					this.#diagnostic = typeof message.message === "string"
						? message.message
						: "node_backend_worker_start_failed";
					reject(new Error(this.#diagnostic));
				}
			});
			worker.once("error", () => {
				this.#diagnostic = "node_backend_worker_failed";
				if (!started) reject(new Error(this.#diagnostic));
			});
			worker.once("exit", (code) => {
				if (worker !== this.#worker) return;
				this.#worker = null;
				if (!started) {
					reject(new Error(this.#diagnostic || "node_backend_worker_exited"));
					return;
				}
				if (!this.#closed && !this.#restarting) this.#resolveOnce(code === 0 ? 0 : 1);
			});
		});
		return new Set(this.#publishedInterrupts);
	}

	#handleWorkerChunk(chunk: string): void {
		this.#clientInput.write(chunk);
		this.#workerLineBuffer += chunk;
		let newline = this.#workerLineBuffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.#workerLineBuffer.slice(0, newline);
			this.#workerLineBuffer = this.#workerLineBuffer.slice(newline + 1);
			this.#trackWorkerMessage(line);
			newline = this.#workerLineBuffer.indexOf("\n");
		}
	}

	#trackWorkerMessage(line: string): void {
		const message = parseJsonObject(line);
		if (!message) return;
		if ((typeof message.id === "string" || typeof message.id === "number")
			&& ("result" in message || "error" in message)) {
			const key = rpcKey(message.id);
			this.#pendingRequests.delete(key);
			const interrupt = this.#pendingInterrupts.get(key);
			if (interrupt) {
				clearTimeout(interrupt.timer);
				this.#pendingInterrupts.delete(key);
			}
			return;
		}
		if (typeof message.method !== "string" || !isObject(message.params)) return;
		if (message.method === "runtime.ready" || message.method === "session.changed") {
			this.#sessionId = stringValue(message.params.session_id) ?? this.#sessionId;
		}
		if (message.method === "status.changed") {
			this.#sessionId = stringValue(message.params.session_id) ?? this.#sessionId;
			this.#model = stringValue(message.params.model) ?? this.#model;
		}
		if (message.method === "turn.started") {
			const turnId = stringValue(message.params.turn_id);
			const clientTurnId = stringValue(message.params.client_turn_id);
			if (turnId && clientTurnId) this.#activeTurn = { turnId, clientTurnId };
		}
		if (["turn.completed", "turn.failed", "turn.interrupted"].includes(message.method)) {
			const turnId = stringValue(message.params.turn_id);
			if (message.method === "turn.interrupted" && turnId && this.#sessionId) {
				this.#publishedInterrupts.add(interruptKey(this.#sessionId, turnId));
			}
			if (!turnId || turnId === this.#activeTurn?.turnId) this.#activeTurn = undefined;
		}
	}

	#flushQueuedInput(): void {
		if (this.#restarting || !this.#worker || this.#queuedInput.length === 0) return;
		const queued = this.#queuedInput;
		this.#queuedInput = [];
		for (const chunk of queued) this.#worker.postMessage({ type: "input", chunk });
	}

	#writeResult(id: RpcId, result: JsonObject): void {
		this.#clientInput.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
	}

	#writeError(id: RpcId, code: string, message: string): void {
		this.#clientInput.write(`${JSON.stringify({
			jsonrpc: "2.0",
			id,
			error: { code, message },
		})}\n`);
	}

	#clearInterrupts(): void {
		for (const pending of this.#pendingInterrupts.values()) clearTimeout(pending.timer);
		this.#pendingInterrupts.clear();
	}

	#terminateCurrentWorker(): void {
		const worker = this.#worker;
		this.#worker = null;
		void worker?.terminate();
	}

	#resolveOnce(code: number): void {
		if (this.#completionResolved) return;
		this.#completionResolved = true;
		this.#resolveCompletion(code);
	}
}

function parseJsonObject(line: string): JsonObject | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return isObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function rpcKey(id: RpcId): string {
	return `${typeof id}:${String(id)}`;
}

function interruptKey(sessionId: string, turnId: string): string {
	return `${sessionId}\u0000${turnId}`;
}

function flagValue(args: readonly string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

function withFlag(args: readonly string[], flag: string, value: string): readonly string[] {
	const result = [...args];
	const index = result.indexOf(flag);
	if (index >= 0) {
		result[index + 1] = value;
	} else {
		result.push(flag, value);
	}
	return result;
}

function waitForExit(worker: Worker): Promise<void> {
	return new Promise((resolve) => {
		if (worker.threadId === -1) {
			resolve();
			return;
		}
		worker.once("exit", () => resolve());
	});
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise.then(() => true, () => true),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
				timer.unref();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
