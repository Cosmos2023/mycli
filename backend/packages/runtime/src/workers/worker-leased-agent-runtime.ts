import type {
	AgentThreadRuntimeCreateInput,
	AgentThreadRuntimeEvent,
	AgentThreadRuntimeFactory,
	AgentThreadRuntimeHandle,
	AgentThreadRuntimeResult,
} from "../agents/agent-supervisor.ts";
import type { AgentWorkerLease } from "./agent-worker-pool.ts";
import type { AgentWorkerPool } from "./agent-worker-pool.ts";
import { WorkerProviderStepExecutor } from "./worker-provider-step-executor.ts";
import { settlementWithin } from "./worker-settlement.ts";

export interface WorkerLeasedAgentThreadRuntimeFactoryOptions {
	readonly pool: AgentWorkerPool;
	readonly delegate: AgentThreadRuntimeFactory;
	readonly hardInterrupt?: boolean;
	readonly cooperativeInterruptTimeoutMs?: number;
	readonly coordinatorCleanupTimeoutMs?: number;
}

export class WorkerLeasedAgentThreadRuntimeFactory implements AgentThreadRuntimeFactory {
	readonly #options: WorkerLeasedAgentThreadRuntimeFactoryOptions;

	constructor(options: WorkerLeasedAgentThreadRuntimeFactoryOptions) {
		this.#options = options;
	}

	async create(input: AgentThreadRuntimeCreateInput): Promise<AgentThreadRuntimeHandle> {
		const handle = await this.#options.delegate.create(input);
		return new WorkerLeasedAgentThreadRuntimeHandle({
			pool: this.#options.pool,
			handle,
			input,
			hardInterrupt: this.#options.hardInterrupt ?? true,
			cooperativeInterruptTimeoutMs: interruptTimeout(
				this.#options.cooperativeInterruptTimeoutMs,
				DEFAULT_COOPERATIVE_INTERRUPT_TIMEOUT_MS,
			),
			coordinatorCleanupTimeoutMs: interruptTimeout(
				this.#options.coordinatorCleanupTimeoutMs,
				DEFAULT_COORDINATOR_CLEANUP_TIMEOUT_MS,
			),
		});
	}
}

interface WorkerLeasedAgentThreadRuntimeHandleOptions {
	readonly pool: AgentWorkerPool;
	readonly handle: AgentThreadRuntimeHandle;
	readonly input: AgentThreadRuntimeCreateInput;
	readonly hardInterrupt: boolean;
	readonly cooperativeInterruptTimeoutMs: number;
	readonly coordinatorCleanupTimeoutMs: number;
}

interface ActiveWorkerRun {
	readonly lease: AgentWorkerLease;
	readonly operation: Promise<unknown>;
	readonly released: Promise<void>;
	interrupt?: Promise<void>;
}

const DEFAULT_COOPERATIVE_INTERRUPT_TIMEOUT_MS = 250;
const DEFAULT_COORDINATOR_CLEANUP_TIMEOUT_MS = 1_000;
const MAX_INTERRUPT_TIMEOUT_MS = 60_000;

export class WorkerLeasedAgentThreadRuntimeHandle implements AgentThreadRuntimeHandle {
	readonly #options: WorkerLeasedAgentThreadRuntimeHandleOptions;
	#activeLease: AgentWorkerLease | undefined;
	#activeRun: ActiveWorkerRun | undefined;
	#closing = false;

	constructor(options: WorkerLeasedAgentThreadRuntimeHandleOptions) {
		this.#options = options;
	}

	async run(
		prompt: string,
		signal: AbortSignal,
		emit: (event: AgentThreadRuntimeEvent) => void,
		turnId: string,
	): Promise<AgentThreadRuntimeResult> {
		return await this.#withLease(turnId, signal, async () => (
			await this.#options.handle.run(prompt, signal, emit, turnId)
		));
	}

	async runMailbox(
		signal: AbortSignal,
		emit: (event: AgentThreadRuntimeEvent) => void,
		turnId: string,
	): Promise<AgentThreadRuntimeResult> {
		const runMailbox = this.#options.handle.runMailbox;
		if (!runMailbox) return await this.run("", signal, emit, turnId);
		return await this.#withLease(turnId, signal, async () => await runMailbox.call(
			this.#options.handle,
			signal,
			emit,
			turnId,
		));
	}

	async markIdle(): Promise<void> {
		await this.#options.handle.markIdle?.();
	}

	async send(message: string): Promise<void> {
		await this.#options.handle.send(message);
	}

	async interrupt(reason: string): Promise<void> {
		const active = this.#activeRun;
		if (!active) {
			await this.#options.handle.interrupt(reason);
			return;
		}
		active.interrupt ??= this.#interruptActiveRun(active, reason);
		await active.interrupt;
	}

	async close(): Promise<void> {
		if (this.#closing) return;
		this.#closing = true;
		try {
			const active = this.#activeRun;
			if (active) {
				active.interrupt ??= this.#interruptActiveRun(active, "agent runtime closed");
				await active.interrupt;
			}
		} finally {
			await this.#options.handle.close();
		}
	}

	async #withLease<Result>(
		turnId: string,
		signal: AbortSignal,
		operation: () => Promise<Result>,
	): Promise<Result> {
		if (this.#closing) throw new Error("agent_runtime_closed");
		if (this.#activeLease) throw new Error("agent_runtime_already_running");
		const lease = await this.#options.pool.acquire({
			priority: "background",
			source: "subagent",
			sessionId: this.#options.input.childSessionId,
			turnId,
			signal,
		});
		this.#activeLease = lease;
		this.#options.handle.bindProviderStepExecutor?.(
			new WorkerProviderStepExecutor({ lease }),
		);
		const operationPromise = Promise.resolve().then(operation);
		let releaseRun!: () => void;
		const released = new Promise<void>((resolve) => { releaseRun = resolve; });
		const active: ActiveWorkerRun = { lease, operation: operationPromise, released };
		this.#activeRun = active;
		try {
			return await operationPromise;
		} finally {
			this.#options.handle.bindProviderStepExecutor?.(undefined);
			if (this.#activeRun === active) this.#activeRun = undefined;
			if (this.#activeLease === lease) this.#activeLease = undefined;
			try {
				await lease.release();
			} finally {
				releaseRun();
			}
		}
	}

	async #interruptActiveRun(active: ActiveWorkerRun, reason: string): Promise<void> {
		let cooperative: Promise<void>;
		try {
			cooperative = this.#options.handle.interrupt(reason);
		} catch {
			cooperative = Promise.resolve();
		}
		void cooperative.catch(() => undefined);
		if (!this.#options.hardInterrupt) {
			await settlementWithin(cooperative, this.#options.cooperativeInterruptTimeoutMs);
			return;
		}
		if (await settlementWithin(
			active.operation,
			this.#options.cooperativeInterruptTimeoutMs,
		) !== "timeout") {
			await active.released;
			const recover = this.#options.handle.recoverInterrupt;
			if (!recover) throw new Error("agent_runtime_interrupt_cleanup_unavailable");
			if (!await recover.call(
				this.#options.handle,
				reason,
				active.lease.turnId,
			)) {
				throw new Error("agent_runtime_interrupt_not_applied");
			}
			return;
		}

		await active.lease.fence(reason);
		const cleanup = this.#options.handle.forceInterrupt;
		const cleaned = cleanup !== undefined && await confirmationWithin(
			cleanup.call(this.#options.handle, reason, active.lease.turnId),
			this.#options.coordinatorCleanupTimeoutMs,
		);
		await active.lease.terminate(reason);
		if (!cleaned) {
			const recover = this.#options.handle.recoverInterrupt;
			if (!recover) throw new Error("agent_runtime_interrupt_cleanup_unavailable");
			if (!await recover.call(this.#options.handle, reason, active.lease.turnId)) {
				throw new Error("agent_runtime_interrupt_not_applied");
			}
		}
	}
}

async function confirmationWithin(operation: Promise<boolean>, timeoutMs: number): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			operation.then((confirmed) => confirmed, () => false),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function interruptTimeout(value: number | undefined, fallback: number): number {
	const selected = value ?? fallback;
	if (!Number.isSafeInteger(selected) || selected <= 0 || selected > MAX_INTERRUPT_TIMEOUT_MS) {
		throw new TypeError("invalid agent Worker interruption timeout");
	}
	return selected;
}
