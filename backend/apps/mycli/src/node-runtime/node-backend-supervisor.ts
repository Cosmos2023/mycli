import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { Worker } from "node:worker_threads";
import { isGatewayMethod, parseGatewayParams, parseJsonRpcMessage, type JsonRpcMessage } from "@mycli/contracts";
import {
	GatewayFrameDecoder, GatewayFrameReader, GatewayRequestBudget, GatewayWriteQueue,
	GatewayFlowControlError, gatewayLimits, type GatewayFlowControlLimits,
} from "@mycli/gateway/flow-control";
import type { NodeBackend, StartNodeBackendOptions } from "./node-backend.ts";
import type {
	StartupProfileSnapshot,
	StartupProfileStage,
} from "./startup-profile.ts";

type JsonObject = Record<string, unknown>;
type RpcId = string | number | null;

interface SupervisedNodeBackendOptions extends StartNodeBackendOptions {
	readonly hardInterruptTimeoutMs?: number;
	readonly workerUrl?: URL;
	readonly limits?: Partial<GatewayFlowControlLimits>;
}

interface PendingRequest {
	readonly id: RpcId;
	readonly generation: number;
	readonly method: string;
	readonly release: () => void;
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

const DEFAULT_COORDINATOR_INTERRUPT_WATCHDOG_MS = 15_000;
const CLOSE_TIMEOUT_MS = 500;

export async function startSupervisedNodeBackend(
	options: SupervisedNodeBackendOptions,
): Promise<NodeBackend> {
	const supervisor = new WorkerNodeBackendSupervisor(options);
	options.signal?.throwIfAborted();
	let abortStartup!: () => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		abortStartup = () => { reject(options.signal?.reason ?? new Error("backend_start_aborted")); };
	});
	options.signal?.addEventListener("abort", abortStartup, { once: true });
	try {
		await Promise.race([supervisor.start(), aborted]);
		return supervisor;
	} catch (error) {
		await supervisor.close();
		throw error;
	} finally {
		options.signal?.removeEventListener("abort", abortStartup);
	}
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
	readonly #limits: GatewayFlowControlLimits;
	readonly #requests: GatewayRequestBudget;
	readonly #deliveries: GatewayRequestBudget;
	readonly #inputDeliveries = new Map<number, () => void>();
	readonly #terminations = new Set<Promise<number>>();
	readonly #clientReader: GatewayFrameReader;
	readonly #writer: GatewayWriteQueue;
	#workerDecoder: GatewayFrameDecoder;
	#nextInputSequence = 1;
	#outputSequence = 0;
	#closePromise: Promise<void> | undefined;
	#transportFailed = false;
	#worker: Worker | null = null;
	#generation = 0;
	#closed = false;
	#completionResolved = false;
	#restarting = false;
	#publishedInterrupts = new Set<string>();
	#sessionId: string | undefined;
	#model: string | undefined;
	#activeTurn: ActiveTurnIdentity | undefined;
	#diagnostic = "";
	#startupProfile: StartupProfileSnapshot | undefined;

	constructor(options: SupervisedNodeBackendOptions) {
		this.#limits = gatewayLimits(options.limits);
		this.#requests = new GatewayRequestBudget(this.#limits);
		this.#deliveries = new GatewayRequestBudget(this.#limits);
		this.#workerDecoder = this.#createWorkerDecoder();
		this.#writer = new GatewayWriteQueue(this.#clientInput, this.#limits, (error) => this.#failConnection(error));
		this.#options = {
			cwd: options.cwd,
			env: { ...options.env },
			args: [...options.args],
			...(options.approvalMode ? { approvalMode: options.approvalMode } : {}),
			...(options.executionMode ? { executionMode: options.executionMode } : {}),
			...(options.reviewRevision ? { reviewRevision: options.reviewRevision } : {}),
			sessionOwnerId: options.sessionOwnerId ?? randomUUID(),
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
			?? DEFAULT_COORDINATOR_INTERRUPT_WATCHDOG_MS;
		this.#sessionId = flagValue(options.args, "--session");
		this.#model = flagValue(options.args, "--model");
		let resolveCompletion!: (code: number) => void;
		this.completion = new Promise<number>((resolve) => { resolveCompletion = resolve; });
		this.#resolveCompletion = resolveCompletion;
		this.transport = {
			input: this.#clientInput,
			output: this.#clientOutput,
			close: () => this.close(),
			diagnostic: () => this.diagnostic(),
		};
		this.#clientReader = new GatewayFrameReader({
			input: this.#clientOutput,
			maxFrameBytes: this.#limits.maxFrameBytes,
			onLine: (line, bytes) => this.#handleClientLine(line, bytes),
			onError: (error) => this.#failConnection(error),
			onClose: () => { void this.close(); },
		});
	}

	async start(): Promise<void> {
		await this.#spawn(this.#options);
	}

	close(): Promise<void> {
		this.#closePromise ??= this.#close();
		return this.#closePromise;
	}

	async #close(): Promise<void> {
		if (this.#closed) { await Promise.allSettled([...this.#terminations]); return; }
		this.#closed = true;
		this.#clientReader.stop();
		this.#clearPending();
		const worker = this.#worker;
		if (worker) {
			worker.postMessage({ type: "close" });
			const closed = await settlesWithin(waitForExit(worker), CLOSE_TIMEOUT_MS);
			if (!closed) await this.#terminate(worker);
		}
		await Promise.allSettled([...this.#terminations]);
		this.#worker = null;
		this.#workerDecoder.close();
		await this.#writer.end();
		this.#clientOutput.end();
		this.#resolveOnce(0);
	}

	kill(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clientReader.stop();
		this.#workerDecoder.close();
		this.#writer.dispose();
		this.#clearPending();
		const worker = this.#worker;
		this.#worker = null;
		if (worker) void this.#terminate(worker);
		this.#clientInput.destroy();
		this.#clientOutput.destroy();
		this.#resolveOnce(1);
	}

	diagnostic(): string {
		return this.#diagnostic;
	}

	startupProfile(): StartupProfileSnapshot | undefined {
		return this.#startupProfile;
	}

	#handleClientLine(line: string, bytes: number): void {
		if (this.#closed) return;
		let request: JsonRpcMessage;
		try { request = parseJsonRpcMessage(JSON.parse(line) as unknown); }
		catch { this.#writeError(null, "invalid_params", "Invalid JSON-RPC request."); return; }
		if (!("id" in request) || !("method" in request)) return;
		try {
			if (isGatewayMethod(request.method)) parseGatewayParams(request.method, request.params ?? {});
		} catch {
			this.#writeError(request.id, "invalid_params", "Invalid gateway parameters.");
			return;
		}
		const key = rpcKey(request.id);
		if (this.#pendingRequests.has(key)) {
			this.#failConnection(new GatewayFlowControlError("invalid_request", "Duplicate pending gateway request id."));
			return;
		}
		if (this.#restarting || !this.#worker) {
			if (request.method === "shutdown") {
				this.#writeResult(request.id, { ok: true });
				void this.close();
			} else {
				this.#writeError(request.id, "gateway_overloaded", "Backend is recovering.", { dispatched: false });
			}
			return;
		}
		const release = this.#requests.acquire(request.method, bytes + 1);
		const delivered = this.#deliveries.acquire(request.method, bytes + 1);
		if (!release || !delivered) {
			release?.();
			delivered?.();
			this.#writeError(request.id, "gateway_overloaded", "Gateway capacity exceeded.", { dispatched: false });
			return;
		}
		const pending: PendingRequest = {
			id: request.id,
			generation: this.#generation,
			method: request.method,
			release,
		};
		this.#pendingRequests.set(key, pending);
		const sequence = this.#nextInputSequence++;
		this.#inputDeliveries.set(sequence, delivered);
		this.#worker.postMessage({ type: "input", generation: this.#generation, sequence, chunk: `${line}\n` });
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
		this.#clearDeliveries();
		try {
			if (staleWorker) await this.#terminate(staleWorker);
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
			if (this.#closed) return;
			if (!publishedInterrupts.has(interruptKey(sessionId, turnId))) {
				throw new Error("interrupted_turn_recovery_not_published");
			}
			for (const [key, pending] of matching) {
				this.#forgetRequest(key);
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
				this.#forgetRequest(key);
				this.#writeError(
					pending.id,
					"internal_error",
					"Backend restarted while the request was running.",
				);
			}
			this.#activeTurn = undefined;
		} catch {
			if (this.#closed) return;
			this.#diagnostic = "node_backend_worker_restart_failed";
			this.#terminateCurrentWorker();
			for (const [key, pending] of matching) {
				this.#forgetRequest(key);
				this.#writeError(pending.id, "internal_error", "Unable to restart interrupted backend.");
			}
			this.#resolveOnce(1);
			void this.close();
		} finally {
			this.#restarting = false;
		}
	}

	async #spawn(options: StartNodeBackendOptions): Promise<ReadonlySet<string>> {
		const generation = ++this.#generation;
		this.#workerDecoder.close();
		this.#workerDecoder = this.#createWorkerDecoder();
		this.#outputSequence = 0;
		this.#nextInputSequence = 1;
		this.#publishedInterrupts = new Set<string>();
		this.#startupProfile = undefined;
		const worker = new Worker(this.#workerUrl, {
			workerData: { generation, options, limits: this.#limits },
		});
		this.#worker = worker;
		let recoveryTimer: NodeJS.Timeout | undefined;
		await new Promise<void>((resolve, reject) => {
			if (options.recoverInterruptedTurns?.length) {
				recoveryTimer = setTimeout(() => reject(new Error("interrupted_turn_recovery_not_published")), this.#limits.writeStallTimeoutMs);
				recoveryTimer.unref();
			}
			let started = false;
			const resolveReady = (): void => {
				if (started && (options.recoverInterruptedTurns ?? []).every((turn) =>
					this.#publishedInterrupts.has(interruptKey(turn.sessionId, turn.turnId)))) resolve();
			};
			worker.on("message", (message: unknown) => {
				if (worker !== this.#worker || !isObject(message) || message.generation !== generation) return;
				if (message.type === "output" && typeof message.chunk === "string") {
					if (!Number.isSafeInteger(message.sequence) || message.sequence !== this.#outputSequence + 1) {
						this.#failConnection(new Error("node_backend_invalid_output_sequence"));
						return;
					}
					this.#outputSequence++;
					try {
						this.#workerDecoder.push(message.chunk);
						this.#writer.enqueue(message.chunk, { onWritten: () => {
							if (worker === this.#worker) worker.postMessage({ type: "output_ack", generation, sequence: message.sequence });
						} });
						resolveReady();
					} catch (error) {
						this.#failConnection(error instanceof Error ? error : new Error("node_backend_invalid_output"));
					}
					return;
				}
				if (message.type === "input_ack" && typeof message.sequence === "number") {
					this.#inputDeliveries.get(message.sequence)?.();
					this.#inputDeliveries.delete(message.sequence);
					return;
				}
				if (message.type === "started") {
					this.#startupProfile = startupProfileSnapshot(message.startupProfile);
					started = true;
					resolveReady();
					return;
				}
				if (message.type === "completion" && typeof message.code === "number") {
					if (!this.#diagnostic && typeof message.diagnostic === "string") this.#diagnostic = message.diagnostic;
					if (!this.#restarting) this.#resolveOnce(message.code);
					return;
				}
				if (message.type === "start_error") {
					this.#diagnostic ||= typeof message.message === "string"
						? message.message
						: "node_backend_worker_start_failed";
					reject(new Error(this.#diagnostic));
				}
			});
			worker.once("error", () => {
				this.#diagnostic ||= "node_backend_worker_failed";
				if (!started) reject(new Error(this.#diagnostic));
			});
			worker.once("exit", (code) => {
				if (worker !== this.#worker) { reject(new Error("node_backend_worker_exited")); return; }
				this.#worker = null;
				if (!started || this.#restarting) {
					reject(new Error(this.#diagnostic || "node_backend_worker_exited"));
					return;
				}
				if (!this.#closed && !this.#restarting) this.#resolveOnce(code === 0 ? 0 : 1);
				if (!this.#closed && code !== 0) this.#diagnostic ||= "node_backend_worker_exited";
				if (!this.#closed) void this.close();
			});
		}).finally(() => { clearTimeout(recoveryTimer); });
		return new Set(this.#publishedInterrupts);
	}

	#createWorkerDecoder(): GatewayFrameDecoder {
		return new GatewayFrameDecoder(this.#limits.maxFrameBytes, (line) => this.#trackWorkerMessage(line));
	}

	#trackWorkerMessage(line: string): void {
		const message = parseJsonRpcMessage(JSON.parse(line) as unknown);
		if ("id" in message && (typeof message.id === "string" || typeof message.id === "number")
			&& !("method" in message)) {
			const key = rpcKey(message.id);
			this.#forgetRequest(key);
			return;
		}
		if (!("method" in message) || !isObject(message.params)) return;
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
			if (this.#restarting && message.method === "turn.interrupted" && turnId && this.#sessionId) {
				this.#publishedInterrupts.add(interruptKey(this.#sessionId, turnId));
			}
			if (!turnId || turnId === this.#activeTurn?.turnId) this.#activeTurn = undefined;
		}
	}

	#writeResult(id: RpcId, result: JsonObject): void {
		this.#write({ jsonrpc: "2.0", id, result });
	}

	#writeError(id: RpcId, code: string, message: string, data?: JsonObject): void {
		this.#write({
			jsonrpc: "2.0",
			id,
			error: { code, message, ...(data ? { data } : {}) },
		});
	}

	#write(message: object): void {
		try { this.#writer.enqueue(`${JSON.stringify(message)}\n`); }
		catch (error) { this.#failConnection(error instanceof Error ? error : new Error("Gateway output failed.")); }
	}

	#failConnection(error: Error): void {
		if (this.#transportFailed) return;
		this.#transportFailed = true;
		this.#diagnostic ||= error instanceof GatewayFlowControlError ? error.code : "node_backend_transport_failed";
		this.#writer.dispose();
		this.#clientInput.destroy();
		this.#clientOutput.destroy();
		this.#resolveOnce(1);
		void this.close();
	}

	#clearDeliveries(): void {
		for (const release of this.#inputDeliveries.values()) release();
		this.#inputDeliveries.clear();
	}

	#clearPending(): void {
		for (const key of this.#pendingRequests.keys()) this.#forgetRequest(key);
		this.#clearDeliveries();
	}

	#forgetRequest(key: string): void {
		this.#pendingRequests.get(key)?.release();
		this.#pendingRequests.delete(key);
		const interrupt = this.#pendingInterrupts.get(key);
		if (interrupt) clearTimeout(interrupt.timer);
		this.#pendingInterrupts.delete(key);
	}

	#terminateCurrentWorker(): void {
		const worker = this.#worker;
		this.#worker = null;
		if (worker) void this.#terminate(worker);
	}

	#terminate(worker: Worker): Promise<number> {
		const termination = worker.terminate();
		this.#terminations.add(termination);
		void termination.then(
			() => { this.#terminations.delete(termination); },
			() => { this.#terminations.delete(termination); },
		);
		return termination;
	}

	#resolveOnce(code: number): void {
		if (this.#completionResolved) return;
		this.#completionResolved = true;
		this.#resolveCompletion(code);
	}
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function startupProfileSnapshot(value: unknown): StartupProfileSnapshot | undefined {
	if (!isObject(value) || value.scope !== "backend" || !Array.isArray(value.marks)) return undefined;
	const marks = value.marks.flatMap((mark) => {
		const elapsedMs = isObject(mark) ? mark.elapsedMs : undefined;
		if (!isObject(mark)
			|| !isBackendStartupStage(mark.stage)
			|| typeof elapsedMs !== "number"
			|| !Number.isSafeInteger(elapsedMs)
			|| elapsedMs < 0) {
			return [];
		}
		return [Object.freeze({ stage: mark.stage, elapsedMs })];
	});
	if (marks.length !== value.marks.length) return undefined;
	return Object.freeze({ scope: "backend", marks: Object.freeze(marks) });
}

function isBackendStartupStage(value: unknown): value is StartupProfileStage {
	return typeof value === "string" && [
		"runtime_entered",
		"config_ready",
		"storage_ready",
		"runtime_components_ready",
		"integration_discovery_started",
		"hooks_ready",
		"skills_ready",
		"mcp_cache_ready",
		"plugins_ready",
		"subagents_ready",
		"integrations_ready",
		"session_prepare_started",
		"session_prepared",
		"trust_ready",
		"session_ready",
		"gateway_ready",
	].includes(value);
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
