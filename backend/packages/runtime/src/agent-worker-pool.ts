import { randomUUID } from "node:crypto";
import { stableModelInputJson } from "@mycli/core";
import { Worker } from "node:worker_threads";
import type { ResourceLimits, TransferListItem } from "node:worker_threads";
import type { AgentLoopPriority } from "./agent-loop-contracts.ts";
import { AGENT_WORKER_PROVIDER_RPC_MAX_BYTES } from "./agent-worker-provider-rpc.ts";

export interface AgentWorkerPoolOptions {
	readonly maxWorkers?: number;
	readonly maxQueue?: number;
	readonly warmWorkers?: number;
	readonly startupTimeoutMs?: number;
	readonly shutdownTimeoutMs?: number;
	readonly idleTimeoutMs?: number;
	readonly resourceLimits?: Readonly<ResourceLimits>;
	readonly maxMessageBytes?: number;
	readonly maxJobsPerWorker?: number;
	readonly maxWorkerAgeMs?: number;
	readonly largeContextBytes?: number;
	readonly maxHeapGrowthBytes?: number;
	readonly rssSoftLimitBytes?: number;
	readonly rssHardLimitBytes?: number;
	readonly rssPollIntervalMs?: number;
	readonly softPressureQueueTimeoutMs?: number;
	readonly workerUrl?: URL;
	readonly createId?: () => string;
	readonly clock?: () => string;
	readonly now?: () => number;
	readonly readProcessRssBytes?: () => number;
	readonly coordinatorEpoch?: string;
}

export interface AcquireAgentWorkerLeaseInput {
	readonly priority: AgentLoopPriority;
	readonly source: "root" | "subagent";
	readonly sessionId: string;
	readonly turnId: string;
	readonly signal?: AbortSignal;
}

export interface AgentWorkerLeaseFailure {
	readonly code: "worker_failed" | "worker_terminated";
	readonly message: string;
}

export interface AgentWorkerPoolSnapshot {
	readonly workerCount: number;
	readonly activeLeaseCount: number;
	readonly queuedCount: number;
	readonly workers: readonly Readonly<{
		readonly workerId: string;
		readonly workerGeneration: number;
		readonly threadId: number;
		readonly state: WorkerState;
		readonly leaseId?: string;
		readonly jobId?: string;
	}>[];
}

export interface AgentWorkerResourceMetrics {
	readonly capturedAt: string;
	readonly workerCount: number;
	readonly activeLeaseCount: number;
	readonly queuedCount: number;
	readonly memoryPressure: Readonly<{
		readonly state: AgentWorkerMemoryPressureState;
		readonly rssBytes: number;
		readonly softLimitBytes: number;
		readonly hardLimitBytes: number;
		readonly speculativeWarmingEnabled: boolean;
		readonly retiredIdleWorkerCount: number;
		readonly rejectedLeaseCount: number;
		readonly rejectedBackgroundLeaseCount: number;
	}>;
	readonly workers: readonly Readonly<{
		readonly workerId: string;
		readonly workerGeneration: number;
		readonly threadId: number;
		readonly state: WorkerState;
		readonly resourceLimits: Readonly<ResourceLimits>;
		readonly heap?: Readonly<{
			readonly usedBytes: number;
			readonly totalBytes: number;
			readonly limitBytes: number;
			readonly externalBytes: number;
		}>;
		readonly eventLoop: Readonly<{
			readonly activeMilliseconds: number;
			readonly idleMilliseconds: number;
			readonly utilization: number;
		}>;
		readonly completedJobs: number;
		readonly ageMilliseconds: number;
		readonly largestJobMessageBytes: number;
		readonly messageListenerCount: number;
		readonly heapGrowthBytes?: number;
	}>[];
}

export type AgentWorkerMemoryPressureState = "normal" | "soft" | "hard";

export class AgentWorkerPoolCapacityError extends Error {
	readonly code = "agent_worker_pool_capacity" as const;

	constructor(maxWorkers: number, maxQueue: number) {
		super(`agent_worker_pool_capacity: workers=${maxWorkers} queue=${maxQueue}`);
		this.name = "AgentWorkerPoolCapacityError";
	}
}

export class AgentWorkerPoolMemoryPressureError extends Error {
	readonly code = "agent_worker_pool_memory_pressure" as const;
	readonly pressure: "soft" | "hard";
	readonly outcome: "soft_queue_timeout" | "hard_capacity";
	readonly rssBytes: number;
	readonly limitBytes: number;

	constructor(input: {
		readonly pressure: "soft" | "hard";
		readonly outcome: "soft_queue_timeout" | "hard_capacity";
		readonly rssBytes: number;
		readonly limitBytes: number;
	}) {
		super(
			`agent_worker_pool_memory_pressure: state=${input.pressure} outcome=${input.outcome}`
			+ ` rss_bytes=${input.rssBytes} limit_bytes=${input.limitBytes}`,
		);
		this.name = "AgentWorkerPoolMemoryPressureError";
		this.pressure = input.pressure;
		this.outcome = input.outcome;
		this.rssBytes = input.rssBytes;
		this.limitBytes = input.limitBytes;
	}
}

export class AgentWorkerPoolClosedError extends Error {
	readonly code = "agent_worker_pool_closed" as const;

	constructor() {
		super("agent_worker_pool_closed: pool is closed");
		this.name = "AgentWorkerPoolClosedError";
	}
}

export class AgentWorkerStartupError extends Error {
	readonly code = "agent_worker_startup_failed" as const;

	constructor() {
		super("agent_worker_startup_failed: Worker did not become ready");
		this.name = "AgentWorkerStartupError";
	}
}

export class AgentWorkerMessageSizeError extends Error {
	readonly code = "agent_worker_message_too_large" as const;

	constructor(maxBytes: number) {
		super(`agent_worker_message_too_large: max_bytes=${maxBytes}`);
		this.name = "AgentWorkerMessageSizeError";
	}
}

export class AgentWorkerLease {
	readonly coordinatorEpoch: string;
	readonly workerId: string;
	readonly workerGeneration: number;
	readonly threadId: number;
	readonly leaseId: string;
	readonly jobId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly source: "root" | "subagent";
	readonly acquiredAt: string;
	readonly failure: Promise<AgentWorkerLeaseFailure>;
	readonly #release: () => Promise<void>;
	readonly #fence: (reason: string) => Promise<void>;
	readonly #terminate: (reason: string) => Promise<void>;
	readonly #postMessage: (message: unknown, transferList?: readonly TransferListItem[]) => void;
	readonly #onMessage: (listener: (message: unknown) => void) => () => void;
	#state: "active" | "releasing" | "fenced" | "released" | "terminated" = "active";

	constructor(input: {
		readonly coordinatorEpoch: string;
		readonly workerId: string;
		readonly workerGeneration: number;
		readonly threadId: number;
		readonly leaseId: string;
		readonly jobId: string;
		readonly sessionId: string;
		readonly turnId: string;
		readonly source: "root" | "subagent";
		readonly acquiredAt: string;
		readonly failure: Promise<AgentWorkerLeaseFailure>;
		readonly release: () => Promise<void>;
		readonly fence: (reason: string) => Promise<void>;
		readonly terminate: (reason: string) => Promise<void>;
		readonly postMessage: (
			message: unknown,
			transferList?: readonly TransferListItem[],
		) => void;
		readonly onMessage: (listener: (message: unknown) => void) => () => void;
	}) {
		this.coordinatorEpoch = input.coordinatorEpoch;
		this.workerId = input.workerId;
		this.workerGeneration = input.workerGeneration;
		this.threadId = input.threadId;
		this.leaseId = input.leaseId;
		this.jobId = input.jobId;
		this.sessionId = input.sessionId;
		this.turnId = input.turnId;
		this.source = input.source;
		this.acquiredAt = input.acquiredAt;
		this.failure = input.failure;
		this.#release = input.release;
		this.#fence = input.fence;
		this.#terminate = input.terminate;
		this.#postMessage = input.postMessage;
		this.#onMessage = input.onMessage;
	}

	postMessage(message: unknown, transferList?: readonly TransferListItem[]): void {
		if (this.#state !== "active") throw new AgentWorkerPoolClosedError();
		this.#postMessage(message, transferList);
	}

	onMessage(listener: (message: unknown) => void): () => void {
		if (this.#state !== "active") throw new AgentWorkerPoolClosedError();
		return this.#onMessage(listener);
	}

	async release(): Promise<void> {
		if (this.#state !== "active") return;
		this.#state = "releasing";
		try {
			await this.#release();
		} finally {
			this.#state = "released";
		}
	}

	async fence(reason = "targeted interruption"): Promise<void> {
		if (this.#state !== "active") return;
		this.#state = "fenced";
		await this.#fence(reason);
	}

	async terminate(reason = "targeted termination"): Promise<void> {
		if (this.#state !== "active" && this.#state !== "fenced") return;
		this.#state = "terminated";
		await this.#terminate(reason);
	}
}

type WorkerState = "starting" | "idle" | "assigning" | "leased" | "releasing" | "fenced" | "stopping";

interface PendingLease {
	readonly sequence: number;
	readonly enqueuedAtMilliseconds: number;
	readonly input: AcquireAgentWorkerLeaseInput;
	readonly resolve: (lease: AgentWorkerLease) => void;
	readonly reject: (error: Error) => void;
	readonly removeAbort?: () => void;
}

interface ActiveLeaseIdentity {
	readonly leaseId: string;
	readonly jobId: string;
	readonly sessionId: string;
	readonly turnId: string;
	readonly source: "root" | "subagent";
	readonly failure: Deferred<AgentWorkerLeaseFailure>;
	readonly messageListeners: Set<(message: unknown) => void>;
}

interface WorkerRecord {
	readonly workerId: string;
	readonly workerGeneration: number;
	readonly worker: Worker;
	state: WorkerState;
	lease?: ActiveLeaseIdentity;
	idleTimer?: NodeJS.Timeout;
	ready: Deferred<void>;
	control?: Deferred<void>;
	controlKind?: "lease" | "release" | "shutdown";
	expectedExit: boolean;
	readonly createdAtMilliseconds: number;
	completedJobs: number;
	largestJobMessageBytes: number;
	initialHeapUsedBytes?: number;
}

interface Deferred<Value> {
	readonly promise: Promise<Value>;
	readonly resolve: (value: Value) => void;
	readonly reject: (error: Error) => void;
}

const DEFAULT_MAX_WORKERS = 4;
const DEFAULT_MAX_QUEUE = 32;
const DEFAULT_WARM_WORKERS = 0;
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
export const AGENT_WORKER_TRANSPORT_MAX_BYTES = AGENT_WORKER_PROVIDER_RPC_MAX_BYTES;
export const DEFAULT_AGENT_WORKER_RESOURCE_LIMITS: Readonly<ResourceLimits> = Object.freeze({
	maxYoungGenerationSizeMb: 16,
	maxOldGenerationSizeMb: 192,
	codeRangeSizeMb: 64,
	stackSizeMb: 4,
});
export const DEFAULT_AGENT_WORKER_MAX_JOBS = 100;
export const DEFAULT_AGENT_WORKER_MAX_AGE_MS = 30 * 60 * 1_000;
export const DEFAULT_AGENT_WORKER_LARGE_CONTEXT_BYTES = 1024 * 1024;
export const DEFAULT_AGENT_WORKER_MAX_HEAP_GROWTH_BYTES = 32 * 1024 * 1024;
export const DEFAULT_AGENT_WORKER_RSS_SOFT_LIMIT_BYTES = 1536 * 1024 * 1024;
export const DEFAULT_AGENT_WORKER_RSS_HARD_LIMIT_BYTES = 2048 * 1024 * 1024;
export const DEFAULT_AGENT_WORKER_RSS_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_AGENT_WORKER_SOFT_PRESSURE_QUEUE_TIMEOUT_MS = 30_000;

export class AgentWorkerPool {
	readonly #coordinatorEpoch: string;
	readonly #maxWorkers: number;
	readonly #maxQueue: number;
	readonly #warmWorkers: number;
	readonly #startupTimeoutMs: number;
	readonly #shutdownTimeoutMs: number;
	readonly #idleTimeoutMs: number;
	readonly #resourceLimits: Readonly<ResourceLimits>;
	readonly #maxMessageBytes: number;
	readonly #maxJobsPerWorker: number;
	readonly #maxWorkerAgeMs: number;
	readonly #largeContextBytes: number;
	readonly #maxHeapGrowthBytes: number;
	readonly #rssSoftLimitBytes: number;
	readonly #rssHardLimitBytes: number;
	readonly #rssPollIntervalMs: number;
	readonly #softPressureQueueTimeoutMs: number;
	readonly #workerUrl: URL;
	readonly #createId: () => string;
	readonly #clock: () => string;
	readonly #now: () => number;
	readonly #readProcessRssBytes: () => number;
	readonly #workers = new Map<string, WorkerRecord>();
	readonly #generations = new Map<string, number>();
	readonly #queue: PendingLease[] = [];
	#sequence = 0;
	#closing = false;
	#started = false;
	#rssTimer: NodeJS.Timeout | undefined;
	#processRssBytes = 0;
	#memoryPressureState: AgentWorkerMemoryPressureState = "normal";
	#pressureRetiredIdleWorkerCount = 0;
	#pressureRejectedLeaseCount = 0;
	#pressureRejectedBackgroundLeaseCount = 0;

	constructor(options: AgentWorkerPoolOptions = {}) {
		this.#coordinatorEpoch = requiredIdentity(
			options.coordinatorEpoch ?? randomUUID(),
			"coordinatorEpoch",
		);
		this.#maxWorkers = positiveInteger(options.maxWorkers ?? DEFAULT_MAX_WORKERS, "maxWorkers");
		this.#maxQueue = nonNegativeInteger(options.maxQueue ?? DEFAULT_MAX_QUEUE, "maxQueue");
		this.#warmWorkers = nonNegativeInteger(
			options.warmWorkers ?? DEFAULT_WARM_WORKERS,
			"warmWorkers",
		);
		if (this.#warmWorkers > this.#maxWorkers) {
			throw new TypeError("warmWorkers must not exceed maxWorkers");
		}
		this.#startupTimeoutMs = positiveInteger(
			options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
			"startupTimeoutMs",
		);
		this.#shutdownTimeoutMs = positiveInteger(
			options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
			"shutdownTimeoutMs",
		);
		this.#idleTimeoutMs = positiveInteger(
			options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
			"idleTimeoutMs",
		);
		this.#resourceLimits = resourceLimits(options.resourceLimits);
		this.#maxMessageBytes = boundedPositiveInteger(
			options.maxMessageBytes ?? AGENT_WORKER_TRANSPORT_MAX_BYTES,
			"maxMessageBytes",
			AGENT_WORKER_TRANSPORT_MAX_BYTES,
		);
		this.#maxJobsPerWorker = positiveInteger(
			options.maxJobsPerWorker ?? DEFAULT_AGENT_WORKER_MAX_JOBS,
			"maxJobsPerWorker",
		);
		this.#maxWorkerAgeMs = positiveInteger(
			options.maxWorkerAgeMs ?? DEFAULT_AGENT_WORKER_MAX_AGE_MS,
			"maxWorkerAgeMs",
		);
		this.#largeContextBytes = boundedPositiveInteger(
			options.largeContextBytes
				?? Math.min(DEFAULT_AGENT_WORKER_LARGE_CONTEXT_BYTES, this.#maxMessageBytes),
			"largeContextBytes",
			this.#maxMessageBytes,
		);
		this.#maxHeapGrowthBytes = positiveInteger(
			options.maxHeapGrowthBytes ?? DEFAULT_AGENT_WORKER_MAX_HEAP_GROWTH_BYTES,
			"maxHeapGrowthBytes",
		);
		this.#rssSoftLimitBytes = positiveInteger(
			options.rssSoftLimitBytes ?? DEFAULT_AGENT_WORKER_RSS_SOFT_LIMIT_BYTES,
			"rssSoftLimitBytes",
		);
		this.#rssHardLimitBytes = positiveInteger(
			options.rssHardLimitBytes ?? DEFAULT_AGENT_WORKER_RSS_HARD_LIMIT_BYTES,
			"rssHardLimitBytes",
		);
		if (this.#rssHardLimitBytes <= this.#rssSoftLimitBytes) {
			throw new TypeError("rssHardLimitBytes must exceed rssSoftLimitBytes");
		}
		this.#rssPollIntervalMs = positiveInteger(
			options.rssPollIntervalMs ?? DEFAULT_AGENT_WORKER_RSS_POLL_INTERVAL_MS,
			"rssPollIntervalMs",
		);
		this.#softPressureQueueTimeoutMs = positiveInteger(
			options.softPressureQueueTimeoutMs
				?? DEFAULT_AGENT_WORKER_SOFT_PRESSURE_QUEUE_TIMEOUT_MS,
			"softPressureQueueTimeoutMs",
		);
		this.#workerUrl = options.workerUrl ?? new URL(
			`./agent-worker-entrypoint${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
			import.meta.url,
		);
		this.#createId = options.createId ?? randomUUID;
		this.#clock = options.clock ?? (() => new Date().toISOString());
		this.#now = options.now ?? Date.now;
		this.#readProcessRssBytes = options.readProcessRssBytes ?? (() => process.memoryUsage.rss());
	}

	async start(): Promise<void> {
		if (this.#closing) throw new AgentWorkerPoolClosedError();
		if (this.#started) return;
		this.#started = true;
		this.#sampleMemoryPressure();
		this.#startRssMonitor();
		if (this.#memoryPressureState !== "normal") return;
		await Promise.all(Array.from({ length: this.#warmWorkers }, async () => {
			await this.#spawnWorker();
		}));
	}

	acquire(input: AcquireAgentWorkerLeaseInput): Promise<AgentWorkerLease> {
		if (this.#closing) return Promise.reject(new AgentWorkerPoolClosedError());
		validateAcquireInput(input);
		if (input.signal?.aborted) return Promise.reject(abortError(input.signal));
		this.#sampleMemoryPressure();
		if (this.#memoryPressureState === "hard"
			&& (input.priority === "background" || !this.#hasIdleWorker())) {
			this.#pressureRejectedLeaseCount += 1;
			if (input.priority === "background") this.#pressureRejectedBackgroundLeaseCount += 1;
			return Promise.reject(this.#memoryPressureError("hard_capacity"));
		}
		const outstanding = this.#queue.length + [...this.#workers.values()].filter((worker) => (
			worker.state === "assigning" || worker.state === "leased" || worker.state === "releasing"
		)).length;
		if (outstanding >= this.#maxWorkers + this.#maxQueue) {
			if (this.#memoryPressureState === "hard") {
				this.#pressureRejectedLeaseCount += 1;
				if (input.priority === "background") this.#pressureRejectedBackgroundLeaseCount += 1;
				return Promise.reject(this.#memoryPressureError("hard_capacity"));
			}
			return Promise.reject(new AgentWorkerPoolCapacityError(this.#maxWorkers, this.#maxQueue));
		}
		this.#started = true;
		this.#startRssMonitor();
		return new Promise<AgentWorkerLease>((resolve, reject) => {
			const pending: PendingLease = {
				sequence: ++this.#sequence,
				enqueuedAtMilliseconds: this.#now(),
				input,
				resolve,
				reject,
				...(input.signal ? {
					removeAbort: addAbortListener(input.signal, () => {
						const index = this.#queue.indexOf(pending);
						if (index < 0) return;
						this.#queue.splice(index, 1);
						reject(abortError(input.signal!));
						this.#syncRssMonitorReference();
					}),
				} : {}),
			};
			this.#queue.push(pending);
			this.#queue.sort(comparePendingLease);
			this.#dispatch();
		});
	}

	snapshot(): AgentWorkerPoolSnapshot {
		const workers = [...this.#workers.values()]
			.sort((left, right) => left.workerId.localeCompare(right.workerId))
			.map((record) => Object.freeze({
				workerId: record.workerId,
				workerGeneration: record.workerGeneration,
				threadId: record.worker.threadId,
				state: record.state,
				...(record.lease ? {
					leaseId: record.lease.leaseId,
					jobId: record.lease.jobId,
				} : {}),
			}));
		return Object.freeze({
			workerCount: workers.length,
			activeLeaseCount: workers.filter((worker) => worker.leaseId !== undefined).length,
			queuedCount: this.#queue.length,
			workers: Object.freeze(workers),
		});
	}

	async metrics(): Promise<AgentWorkerResourceMetrics> {
		const capturedAt = this.#clock();
		this.#sampleMemoryPressure();
		const records = [...this.#workers.values()]
			.sort((left, right) => left.workerId.localeCompare(right.workerId));
		const workers = await Promise.all(records.map(async (record) => {
			const eventLoop = record.worker.performance.eventLoopUtilization();
			const heap = await record.worker.getHeapStatistics().catch(() => undefined);
			return Object.freeze({
				workerId: record.workerId,
				workerGeneration: record.workerGeneration,
				threadId: record.worker.threadId,
				state: record.state,
				resourceLimits: Object.freeze({ ...record.worker.resourceLimits }),
				...(heap ? {
					heap: Object.freeze({
						usedBytes: heap.used_heap_size,
						totalBytes: heap.total_heap_size,
						limitBytes: heap.heap_size_limit,
						externalBytes: heap.external_memory,
					}),
				} : {}),
					eventLoop: Object.freeze({
					activeMilliseconds: eventLoop.active,
					idleMilliseconds: eventLoop.idle,
					utilization: eventLoop.utilization,
				}),
				completedJobs: record.completedJobs,
				ageMilliseconds: Math.max(0, this.#now() - record.createdAtMilliseconds),
				largestJobMessageBytes: record.largestJobMessageBytes,
				messageListenerCount: record.lease?.messageListeners.size ?? 0,
				...(heap && record.initialHeapUsedBytes !== undefined ? {
					heapGrowthBytes: Math.max(0, heap.used_heap_size - record.initialHeapUsedBytes),
				} : {}),
			});
		}));
		return Object.freeze({
			capturedAt,
			workerCount: workers.length,
			activeLeaseCount: workers.filter((worker) => (
				worker.state === "assigning"
				|| worker.state === "leased"
				|| worker.state === "releasing"
				|| worker.state === "fenced"
			)).length,
			queuedCount: this.#queue.length,
			memoryPressure: Object.freeze({
				state: this.#memoryPressureState,
				rssBytes: this.#processRssBytes,
				softLimitBytes: this.#rssSoftLimitBytes,
				hardLimitBytes: this.#rssHardLimitBytes,
				speculativeWarmingEnabled: this.#memoryPressureState === "normal",
				retiredIdleWorkerCount: this.#pressureRetiredIdleWorkerCount,
				rejectedLeaseCount: this.#pressureRejectedLeaseCount,
				rejectedBackgroundLeaseCount: this.#pressureRejectedBackgroundLeaseCount,
			}),
			workers: Object.freeze(workers),
		});
	}

	async close(): Promise<void> {
		if (this.#closing) return;
		this.#closing = true;
		if (this.#rssTimer) clearInterval(this.#rssTimer);
		this.#rssTimer = undefined;
		for (const pending of this.#queue.splice(0)) {
			pending.removeAbort?.();
			pending.reject(new AgentWorkerPoolClosedError());
		}
		await Promise.all([...this.#workers.values()].map(async (record) => {
			await this.#stopWorker(record, "worker_terminated", "pool shutdown");
		}));
	}

	#dispatch(): void {
		if (this.#closing) return;
		this.#sampleMemoryPressure();
		if (this.#memoryPressureState === "hard") this.#rejectHardPressureQueuedWork();
		if (this.#memoryPressureState === "soft") this.#rejectExpiredSoftPressureWork();
		this.#retirePressureIdleWorkers();
		for (;;) {
			const pending = this.#queue[0];
			const idle = [...this.#workers.values()].find((worker) => worker.state === "idle");
			if (!pending || !idle || !this.#canDispatch(pending)) break;
			this.#queue.shift();
			pending.removeAbort?.();
			void this.#assign(idle, pending);
		}
		const available = [...this.#workers.values()].filter((worker) => (
			worker.state === "starting" || worker.state === "idle"
		)).length;
		const dispatchableQueuedCount = this.#queue.filter((pending) => this.#canExpand(pending)).length;
		const needed = Math.min(
			dispatchableQueuedCount - available,
			this.#maxWorkers - this.#workers.size,
		);
		for (let index = 0; index < needed; index += 1) {
			void this.#spawnWorker().catch((error: unknown) => {
				const pending = this.#queue.shift();
				pending?.removeAbort?.();
				pending?.reject(error instanceof Error ? error : new AgentWorkerStartupError());
				this.#dispatch();
			});
		}
		if (this.#memoryPressureState === "normal") this.#ensureWarmCapacity();
		this.#syncRssMonitorReference();
	}

	async #spawnWorker(): Promise<WorkerRecord> {
		if (this.#closing) throw new AgentWorkerPoolClosedError();
		const workerId = this.#availableWorkerId();
		const workerGeneration = (this.#generations.get(workerId) ?? 0) + 1;
		this.#generations.set(workerId, workerGeneration);
		const ready = deferred<void>();
		const worker = new Worker(this.#workerUrl, {
			workerData: { workerId, workerGeneration },
			resourceLimits: this.#resourceLimits,
		});
		const record: WorkerRecord = {
			workerId,
			workerGeneration,
			worker,
			state: "starting",
			ready,
			expectedExit: false,
			createdAtMilliseconds: this.#now(),
			completedJobs: 0,
			largestJobMessageBytes: 0,
		};
		this.#workers.set(workerId, record);
		worker.on("message", (message: unknown) => this.#handleMessage(record, message));
		worker.once("error", () => this.#handleExit(record, "worker failed"));
		worker.once("exit", (code) => this.#handleExit(record, `worker exited with code ${code}`));
		try {
			await withTimeout(ready.promise, this.#startupTimeoutMs, new AgentWorkerStartupError());
			record.initialHeapUsedBytes = (await worker.getHeapStatistics()).used_heap_size;
		} catch (error) {
			await this.#stopWorker(record, "worker_failed", "worker startup failed");
			throw error;
		}
		this.#scheduleIdleRetirement(record);
		this.#dispatch();
		return record;
	}

	async #assign(record: WorkerRecord, pending: PendingLease): Promise<void> {
		if (pending.input.signal?.aborted) {
			pending.reject(abortError(pending.input.signal));
			this.#dispatch();
			return;
		}
		this.#clearIdleTimer(record);
		record.state = "assigning";
		record.largestJobMessageBytes = 0;
		const failure = deferred<AgentWorkerLeaseFailure>();
		const identity: ActiveLeaseIdentity = Object.freeze({
			leaseId: this.#createId(),
			jobId: this.#createId(),
			sessionId: pending.input.sessionId,
			turnId: pending.input.turnId,
			source: pending.input.source,
			failure,
			messageListeners: new Set<(message: unknown) => void>(),
		});
		record.lease = identity;
		const acknowledgement = deferred<void>();
		record.control = acknowledgement;
		record.controlKind = "lease";
		this.#postMessage(record, {
			type: "lease",
			coordinatorEpoch: this.#coordinatorEpoch,
			workerId: record.workerId,
			workerGeneration: record.workerGeneration,
			leaseId: identity.leaseId,
			jobId: identity.jobId,
			sessionId: identity.sessionId,
			turnId: identity.turnId,
		});
		try {
			await withTimeout(
				acknowledgement.promise,
				this.#startupTimeoutMs,
				new AgentWorkerStartupError(),
			);
		} catch (error) {
			pending.reject(error instanceof Error ? error : new AgentWorkerStartupError());
			await this.#stopWorker(record, "worker_failed", "worker lease failed");
			this.#dispatch();
			return;
		}
		record.control = undefined;
		record.controlKind = undefined;
		record.state = "leased";
		const lease = new AgentWorkerLease({
			coordinatorEpoch: this.#coordinatorEpoch,
			workerId: record.workerId,
			workerGeneration: record.workerGeneration,
			threadId: record.worker.threadId,
			leaseId: identity.leaseId,
			jobId: identity.jobId,
			sessionId: identity.sessionId,
			turnId: identity.turnId,
			source: identity.source,
			acquiredAt: this.#clock(),
			failure: identity.failure.promise,
			release: async () => this.#release(record, identity),
			fence: async () => this.#fenceLease(record, identity),
			terminate: async (reason) => this.#terminateLease(record, identity, reason),
			postMessage: (message, transferList) => {
				if (record.state !== "leased" || record.lease !== identity) {
					throw new AgentWorkerPoolClosedError();
				}
				this.#postMessage(record, message, transferList, true);
			},
			onMessage: (listener) => {
				if (record.state !== "leased" || record.lease !== identity) {
					throw new AgentWorkerPoolClosedError();
				}
				identity.messageListeners.add(listener);
				return () => identity.messageListeners.delete(listener);
			},
		});
		pending.resolve(lease);
		this.#dispatch();
	}

	async #release(record: WorkerRecord, identity: ActiveLeaseIdentity): Promise<void> {
		if (record.lease !== identity || record.state !== "leased") return;
		record.state = "releasing";
		const acknowledgement = deferred<void>();
		record.control = acknowledgement;
		record.controlKind = "release";
		this.#postMessage(record, {
			type: "release",
			leaseId: identity.leaseId,
			jobId: identity.jobId,
		});
		try {
			await withTimeout(
				acknowledgement.promise,
				this.#shutdownTimeoutMs,
				new AgentWorkerPoolClosedError(),
			);
		} catch (error) {
			await this.#stopWorker(record, "worker_failed", "worker release failed");
			void this.#replaceWorker();
			this.#dispatch();
			throw error;
		}
		record.control = undefined;
		record.controlKind = undefined;
		identity.messageListeners.clear();
		record.lease = undefined;
		record.completedJobs += 1;
		const recycleReason = await this.#idleRecycleReason(record);
		if (recycleReason) {
			await this.#stopWorker(record, "worker_terminated", recycleReason);
			this.#ensureWarmCapacity();
			this.#dispatch();
			return;
		}
		record.state = "idle";
		this.#scheduleIdleRetirement(record);
		this.#dispatch();
	}

	async #terminateLease(
		record: WorkerRecord,
		identity: ActiveLeaseIdentity,
		reason: string,
	): Promise<void> {
		if (record.lease !== identity) return;
		await this.#stopWorker(record, "worker_terminated", boundedReason(reason));
		await this.#replaceWorker();
		this.#dispatch();
	}

	async #fenceLease(
		record: WorkerRecord,
		identity: ActiveLeaseIdentity,
	): Promise<void> {
		if (record.lease !== identity || record.state !== "leased") return;
		record.state = "fenced";
		identity.messageListeners.clear();
	}

	#handleMessage(record: WorkerRecord, value: unknown): void {
		if (record.state === "fenced") return;
		try {
			assertMessageSize(value, this.#maxMessageBytes);
		} catch {
			this.#failWorker(record, "worker protocol payload exceeded byte limit");
			return;
		}
		if (record.state === "stopping") {
			if (isRecord(value)
				&& value.workerId === record.workerId
				&& value.workerGeneration === record.workerGeneration
				&& value.type === "stopped"
				&& record.controlKind === "shutdown") {
				record.control?.resolve();
			}
			return;
		}
		if (!isRecord(value)
			|| value.workerId !== record.workerId
			|| value.workerGeneration !== record.workerGeneration
			|| typeof value.type !== "string") {
			this.#failWorker(record, "worker protocol failure");
			return;
		}
		if (value.type === "ready" && record.state === "starting") {
			record.state = "idle";
			record.ready.resolve();
			return;
		}
		const lease = record.lease;
		if (value.type === "leased" && record.controlKind === "lease" && lease
			&& value.leaseId === lease.leaseId && value.jobId === lease.jobId) {
			record.control?.resolve();
			return;
		}
		if (value.type === "released" && record.controlKind === "release" && lease
			&& value.leaseId === lease.leaseId && value.jobId === lease.jobId) {
			record.control?.resolve();
			return;
		}
		if (record.state === "leased" && lease && lease.messageListeners.size > 0) {
			record.largestJobMessageBytes = Math.max(
				record.largestJobMessageBytes,
				messageBytes(value),
			);
			for (const listener of lease.messageListeners) listener(value);
			return;
		}
		this.#failWorker(record, "worker protocol failure");
	}

	#handleExit(record: WorkerRecord, reason: string): void {
		if (this.#workers.get(record.workerId) !== record) return;
		this.#workers.delete(record.workerId);
		this.#clearIdleTimer(record);
		record.ready.reject(new AgentWorkerStartupError());
		record.control?.reject(new AgentWorkerPoolClosedError());
		const failedLease = record.lease;
		failedLease?.messageListeners.clear();
		if (!record.expectedExit) {
			failedLease?.failure.resolve(Object.freeze({ code: "worker_failed", message: reason }));
			if (failedLease) void this.#replaceWorker();
			this.#ensureWarmCapacity();
			this.#dispatch();
		}
	}

	async #stopWorker(
		record: WorkerRecord,
		failureCode: AgentWorkerLeaseFailure["code"],
		reason: string,
	): Promise<void> {
		if (this.#workers.get(record.workerId) !== record) return;
		this.#clearIdleTimer(record);
		record.state = "stopping";
		record.expectedExit = true;
		const lease = record.lease;
		record.lease = undefined;
		lease?.messageListeners.clear();
		lease?.failure.resolve(Object.freeze({ code: failureCode, message: boundedReason(reason) }));
		const acknowledgement = deferred<void>();
		record.control?.reject(new AgentWorkerPoolClosedError());
		record.control = acknowledgement;
		record.controlKind = "shutdown";
		try {
			this.#postMessage(record, { type: "shutdown" });
			await withTimeout(
				acknowledgement.promise,
				this.#shutdownTimeoutMs,
				new AgentWorkerPoolClosedError(),
			);
		} catch {
			// Termination below is the bounded fallback.
		}
		await record.worker.terminate();
		if (this.#workers.get(record.workerId) === record) {
			this.#workers.delete(record.workerId);
		}
	}

	#scheduleIdleRetirement(record: WorkerRecord): void {
		this.#clearIdleTimer(record);
		record.idleTimer = setTimeout(() => {
			if (record.state !== "idle") return;
			const idleCount = [...this.#workers.values()].filter((worker) => worker.state === "idle").length;
			if (idleCount <= this.#warmWorkers) return;
			void this.#stopWorker(record, "worker_terminated", "idle retirement");
		}, this.#idleTimeoutMs);
		record.idleTimer.unref();
	}

	#clearIdleTimer(record: WorkerRecord): void {
		if (!record.idleTimer) return;
		clearTimeout(record.idleTimer);
		record.idleTimer = undefined;
	}

	#ensureWarmCapacity(): void {
		if (this.#closing || this.#memoryPressureState !== "normal") return;
		const current = this.#workers.size;
		const desired = Math.min(this.#warmWorkers, this.#maxWorkers);
		for (let index = current; index < desired; index += 1) {
			void this.#spawnWorker().catch(() => undefined);
		}
	}

	async #replaceWorker(): Promise<void> {
		this.#sampleMemoryPressure();
		if (this.#closing
			|| this.#memoryPressureState !== "normal"
			|| this.#workers.size >= this.#maxWorkers) return;
		await this.#spawnWorker().then(() => undefined).catch(() => undefined);
	}

	#failWorker(record: WorkerRecord, reason: string): void {
		void this.#stopWorker(record, "worker_failed", reason).finally(() => {
			void this.#replaceWorker();
			this.#dispatch();
		});
	}

	async #idleRecycleReason(record: WorkerRecord): Promise<string | undefined> {
		if (record.state !== "releasing" || record.lease !== undefined) return undefined;
		if (record.completedJobs >= this.#maxJobsPerWorker) return "job-count recycling";
		if (this.#now() - record.createdAtMilliseconds >= this.#maxWorkerAgeMs) {
			return "age recycling";
		}
		if (record.largestJobMessageBytes >= this.#largeContextBytes) {
			return "large-context recycling";
		}
		const heap = await record.worker.getHeapStatistics().catch(() => undefined);
		if (record.state !== "releasing" || record.lease !== undefined) return undefined;
		if (heap && record.initialHeapUsedBytes !== undefined
			&& heap.used_heap_size - record.initialHeapUsedBytes >= this.#maxHeapGrowthBytes) {
			return "heap-growth recycling";
		}
		return undefined;
	}

	#sampleMemoryPressure(): void {
		const rssBytes = nonNegativeInteger(this.#readProcessRssBytes(), "processRssBytes");
		this.#processRssBytes = rssBytes;
		this.#memoryPressureState = rssBytes >= this.#rssHardLimitBytes
			? "hard"
			: rssBytes >= this.#rssSoftLimitBytes
				? "soft"
				: "normal";
	}

	#startRssMonitor(): void {
		if (this.#closing) return;
		if (this.#rssTimer) {
			this.#syncRssMonitorReference();
			return;
		}
		this.#rssTimer = setInterval(() => this.#dispatch(), this.#rssPollIntervalMs);
		this.#syncRssMonitorReference();
	}

	#syncRssMonitorReference(): void {
		if (!this.#rssTimer) return;
		if (this.#queue.length > 0) {
			this.#rssTimer.ref();
			return;
		}
		this.#rssTimer.unref();
	}

	#canDispatch(pending: PendingLease): boolean {
		return this.#memoryPressureState === "normal" || pending.input.priority === "interactive";
	}

	#canExpand(pending: PendingLease): boolean {
		if (this.#memoryPressureState === "hard") return false;
		return this.#memoryPressureState === "normal" || pending.input.priority === "interactive";
	}

	#rejectHardPressureQueuedWork(): void {
		let availableIdleWorkers = [...this.#workers.values()].filter((worker) => (
			worker.state === "idle"
		)).length;
		for (let index = 0; index < this.#queue.length;) {
			const pending = this.#queue[index];
			if (!pending) break;
			if (pending.input.priority === "interactive" && availableIdleWorkers > 0) {
				availableIdleWorkers -= 1;
				index += 1;
				continue;
			}
			this.#queue.splice(index, 1);
			pending.removeAbort?.();
			this.#pressureRejectedLeaseCount += 1;
			if (pending.input.priority === "background") {
				this.#pressureRejectedBackgroundLeaseCount += 1;
			}
			pending.reject(this.#memoryPressureError("hard_capacity"));
		}
	}

	#rejectExpiredSoftPressureWork(): void {
		const now = this.#now();
		for (let index = 0; index < this.#queue.length;) {
			const pending = this.#queue[index];
			if (!pending) break;
			if (pending.input.priority !== "background"
				|| now - pending.enqueuedAtMilliseconds < this.#softPressureQueueTimeoutMs) {
				index += 1;
				continue;
			}
			this.#queue.splice(index, 1);
			pending.removeAbort?.();
			this.#pressureRejectedLeaseCount += 1;
			this.#pressureRejectedBackgroundLeaseCount += 1;
			pending.reject(this.#memoryPressureError("soft_queue_timeout"));
		}
	}

	#retirePressureIdleWorkers(): void {
		if (this.#memoryPressureState === "normal") return;
		const requiredInteractiveWorkers = this.#queue.filter((pending) => (
			pending.input.priority === "interactive"
		)).length;
		const idleWorkers = [...this.#workers.values()]
			.filter((worker) => worker.state === "idle")
			.sort((left, right) => left.workerId.localeCompare(right.workerId));
		for (const record of idleWorkers.slice(requiredInteractiveWorkers)) {
			this.#pressureRetiredIdleWorkerCount += 1;
			void this.#stopWorker(record, "worker_terminated", "process RSS pressure retirement")
				.finally(() => this.#dispatch());
		}
	}

	#memoryPressureError(
		outcome: "soft_queue_timeout" | "hard_capacity",
	): AgentWorkerPoolMemoryPressureError {
		const pressure = outcome === "hard_capacity" ? "hard" : "soft";
		return new AgentWorkerPoolMemoryPressureError({
			pressure,
			outcome,
			rssBytes: this.#processRssBytes,
			limitBytes: pressure === "hard" ? this.#rssHardLimitBytes : this.#rssSoftLimitBytes,
		});
	}

	#hasIdleWorker(): boolean {
		return [...this.#workers.values()].some((worker) => worker.state === "idle");
	}

	#postMessage(
		record: WorkerRecord,
		message: unknown,
		transferList?: readonly TransferListItem[],
		trackJobMessage = false,
	): void {
		const bytes = assertMessageSize(message, this.#maxMessageBytes);
		if (trackJobMessage) {
			record.largestJobMessageBytes = Math.max(record.largestJobMessageBytes, bytes);
		}
		record.worker.postMessage(message, transferList);
	}

	#availableWorkerId(): string {
		for (let slot = 1; slot <= this.#maxWorkers; slot += 1) {
			const workerId = `agent-worker-${slot}`;
			if (!this.#workers.has(workerId)) return workerId;
		}
		throw new AgentWorkerPoolCapacityError(this.#maxWorkers, this.#maxQueue);
	}
}

function comparePendingLease(left: PendingLease, right: PendingLease): number {
	const priority = (left.input.priority === "interactive" ? 0 : 1)
		- (right.input.priority === "interactive" ? 0 : 1);
	return priority || left.sequence - right.sequence;
}

function validateAcquireInput(input: AcquireAgentWorkerLeaseInput): void {
	if (input.priority !== "interactive" && input.priority !== "background") {
		throw new TypeError("agent Worker priority is invalid");
	}
	if (input.source !== "root" && input.source !== "subagent") {
		throw new TypeError("agent Worker source is invalid");
	}
	requiredIdentity(input.sessionId, "sessionId");
	requiredIdentity(input.turnId, "turnId");
}

function requiredIdentity(value: string, label: string): string {
	if (!value.trim() || value.length > 256) throw new TypeError(`${label} is invalid`);
	return value;
}

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be positive`);
	return value;
}

function boundedPositiveInteger(value: number, label: string, maximum: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new TypeError(`${label} must be between 1 and ${maximum}`);
	}
	return value;
}

function resourceLimits(value: Readonly<ResourceLimits> | undefined): Readonly<ResourceLimits> {
	const candidate = { ...DEFAULT_AGENT_WORKER_RESOURCE_LIMITS, ...value };
	return Object.freeze({
		maxYoungGenerationSizeMb: boundedPositiveInteger(
			candidate.maxYoungGenerationSizeMb ?? 0,
			"maxYoungGenerationSizeMb",
			4_096,
		),
		maxOldGenerationSizeMb: boundedPositiveInteger(
			candidate.maxOldGenerationSizeMb ?? 0,
			"maxOldGenerationSizeMb",
			4_096,
		),
		codeRangeSizeMb: nonNegativeInteger(candidate.codeRangeSizeMb ?? 0, "codeRangeSizeMb"),
		stackSizeMb: boundedPositiveInteger(candidate.stackSizeMb ?? 0, "stackSizeMb", 64),
	});
}

function nonNegativeInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be non-negative`);
	return value;
}

function deferred<Value>(): Deferred<Value> {
	let resolve!: (value: Value) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function addAbortListener(signal: AbortSignal, listener: () => void): () => void {
	signal.addEventListener("abort", listener, { once: true });
	return () => signal.removeEventListener("abort", listener);
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("agent Worker lease aborted", "AbortError");
}

async function withTimeout<Value>(
	promise: Promise<Value>,
	timeoutMs: number,
	error: Error,
): Promise<Value> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<Value>((_resolve, reject) => {
				timer = setTimeout(() => reject(error), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedReason(value: string): string {
	return value.trim().slice(0, 256) || "agent Worker stopped";
}

function assertMessageSize(value: unknown, maximum: number): number {
	let json: string;
	try {
		json = stableModelInputJson(value);
	} catch {
		throw new AgentWorkerMessageSizeError(maximum);
	}
	const bytes = Buffer.byteLength(json, "utf8");
	if (bytes > maximum) {
		throw new AgentWorkerMessageSizeError(maximum);
	}
	return bytes;
}

function messageBytes(value: unknown): number {
	try {
		return Buffer.byteLength(stableModelInputJson(value), "utf8");
	} catch {
		return 0;
	}
}
