import type { RuntimeTurnRecord } from "@mycli/contracts";
import type { RuntimeEvent } from "@mycli/core";
import type { TurnReservation } from "@mycli/storage";
import type { AgentWorkerLease, AgentWorkerPool } from "./agent-worker-pool.ts";
import type { ExecutionPolicyConfiguration } from "../turns/execution-policy-coordinator.ts";
import type { NodeTurnRuntime } from "../turns/node-turn-runtime.ts";
import type {
	ForceInterruptInput,
	ResolveApprovalInput,
	ResolveClarificationInput,
	SubmitTurnOptions,
	TurnSubmission,
} from "../turns/node-turn-runtime.ts";
import type { ProviderStepExecutor } from "../providers/provider-step-executor.ts";
import { WorkerProviderStepExecutor } from "./worker-provider-step-executor.ts";
import { settlementWithin } from "./worker-settlement.ts";

type RootTurnRuntimeDelegate = Pick<
	NodeTurnRuntime,
	| "agentBudgetExhaustion"
	| "bindProviderStepExecutor"
	| "configureExecutionPolicy"
	| "configureRuntimeContext"
	| "continuationTurnId"
	| "executionPolicySnapshot"
	| "failReservedTurn"
	| "forceInterrupt"
	| "reserve"
	| "resolveApproval"
	| "resolveClarification"
	| "submit"
	> & Pick<NodeTurnRuntime, "queueCoordinator">
	& Partial<Pick<NodeTurnRuntime, "runExecutionSnapshot" | "hasActiveApproval" | "respondActiveApproval">>;

interface RootAgentWorkerPool {
	acquire(input: Parameters<AgentWorkerPool["acquire"]>[0]): Promise<AgentWorkerLease>;
}

export interface WorkerLeasedRootTurnRuntimeOptions {
	readonly pool: RootAgentWorkerPool;
	readonly runtime: RootTurnRuntimeDelegate;
	readonly sessionId: string;
	readonly cooperativeInterruptTimeoutMs?: number;
	readonly coordinatorCleanupTimeoutMs?: number;
	readonly recoverInterrupt?: (
		input: ForceInterruptInput,
	) => RuntimeTurnRecord | undefined | Promise<RuntimeTurnRecord | undefined>;
}

interface ActiveRootRun {
	readonly lease: AgentWorkerLease;
	readonly turnId: string;
	readonly operation: Promise<RuntimeTurnRecord>;
	readonly released: Promise<void>;
	readonly resolveForcedResult: (record: RuntimeTurnRecord) => void;
	fenced?: boolean;
	forceInterrupt?: Promise<RuntimeTurnRecord>;
}

const DEFAULT_COOPERATIVE_INTERRUPT_TIMEOUT_MS = 250;
const DEFAULT_COORDINATOR_CLEANUP_TIMEOUT_MS = 1_000;
const MAX_INTERRUPT_TIMEOUT_MS = 60_000;

export class WorkerLeasedRootTurnRuntime {
	readonly #pool: RootAgentWorkerPool;
	readonly #runtime: RootTurnRuntimeDelegate;
	readonly #sessionId: string;
	readonly #cooperativeInterruptTimeoutMs: number;
	readonly #coordinatorCleanupTimeoutMs: number;
	readonly #recoverInterrupt: WorkerLeasedRootTurnRuntimeOptions["recoverInterrupt"];
	#activeRun: ActiveRootRun | undefined;

	constructor(options: WorkerLeasedRootTurnRuntimeOptions) {
		this.#pool = options.pool;
		this.#runtime = options.runtime;
		this.#sessionId = requiredIdentity(options.sessionId, "sessionId");
		this.#cooperativeInterruptTimeoutMs = interruptTimeout(
			options.cooperativeInterruptTimeoutMs,
			DEFAULT_COOPERATIVE_INTERRUPT_TIMEOUT_MS,
		);
		this.#coordinatorCleanupTimeoutMs = interruptTimeout(
			options.coordinatorCleanupTimeoutMs,
			DEFAULT_COORDINATOR_CLEANUP_TIMEOUT_MS,
		);
		this.#recoverInterrupt = options.recoverInterrupt;
	}

	get queueCoordinator(): NodeTurnRuntime["queueCoordinator"] {
		return this.#runtime.queueCoordinator;
	}

	bindProviderStepExecutor(executor: ProviderStepExecutor | undefined): void {
		this.#runtime.bindProviderStepExecutor(executor);
	}

	continuationTurnId(): string | undefined {
		return this.#runtime.continuationTurnId();
	}

	agentBudgetExhaustion(): ReturnType<NodeTurnRuntime["agentBudgetExhaustion"]> {
		return this.#runtime.agentBudgetExhaustion();
	}

	configureExecutionPolicy(input: ExecutionPolicyConfiguration): void {
		this.#runtime.configureExecutionPolicy(input);
	}

	configureRuntimeContext(input: {
		readonly collaborationMode: string;
		readonly turnId?: string;
	}): void {
		this.#runtime.configureRuntimeContext(input);
	}

	executionPolicySnapshot(): ReturnType<NodeTurnRuntime["executionPolicySnapshot"]> {
		return this.#runtime.executionPolicySnapshot();
	}

	runExecutionSnapshot(turnId: string): ReturnType<NodeTurnRuntime["runExecutionSnapshot"]> {
		return this.#runtime.runExecutionSnapshot?.(turnId);
	}

	reserve(submission: TurnSubmission): TurnReservation {
		return this.#runtime.reserve(submission);
	}

	failReservedTurn(
		reservation: TurnReservation,
		error: unknown,
		emit: (event: RuntimeEvent) => void,
		signal: AbortSignal,
	): Promise<RuntimeTurnRecord> {
		return this.#runtime.failReservedTurn(reservation, error, emit, signal);
	}

	async submit(
		submission: TurnSubmission,
		emit: (event: RuntimeEvent) => void,
		options: SubmitTurnOptions,
	): Promise<RuntimeTurnRecord> {
		const reservation = options.reservation ?? this.#runtime.reserve(submission);
		if (reservation.kind === "existing") {
			return await this.#runtime.submit(submission, emit, { ...options, reservation });
		}
		try {
			return await this.#withLease(
				reservation.turn.turn_id,
				options.signal,
				() => this.#runtime.submit(submission, emit, { ...options, reservation }),
			);
		} catch (error) {
			return await this.#runtime.failReservedTurn(reservation, error, emit, options.signal);
		}
	}

	async resolveApproval(
		input: ResolveApprovalInput,
		emit: (event: RuntimeEvent) => void,
		options: Pick<SubmitTurnOptions, "signal">,
	): Promise<RuntimeTurnRecord> {
		return await this.#withContinuationLease(
			options.signal,
			() => this.#runtime.resolveApproval(input, emit, options),
		);
	}

	hasActiveApproval(decisionId: string): boolean {
		return this.#runtime.hasActiveApproval?.(decisionId) === true;
	}

	respondActiveApproval(input: ResolveApprovalInput): void {
		if (!this.#runtime.respondActiveApproval) throw new Error("approval_not_pending");
		this.#runtime.respondActiveApproval(input);
	}

	async resolveClarification(
		input: ResolveClarificationInput,
		emit: (event: RuntimeEvent) => void,
		options: Pick<SubmitTurnOptions, "signal">,
	): Promise<RuntimeTurnRecord> {
		return await this.#withContinuationLease(
			options.signal,
			() => this.#runtime.resolveClarification(input, emit, options),
		);
	}

	async forceInterrupt(
		input: ForceInterruptInput,
		emit: (event: RuntimeEvent) => void,
	): Promise<RuntimeTurnRecord> {
		const active = this.#activeRun;
		if (!active || active.turnId !== input.turnId) {
			return await this.#runtime.forceInterrupt(input, emit);
		}
		active.forceInterrupt ??= this.#interruptActiveRun(active, input, emit);
		const result = await active.forceInterrupt;
		await active.released;
		return result;
	}

	async #withContinuationLease(
		signal: AbortSignal,
		operation: () => Promise<RuntimeTurnRecord>,
	): Promise<RuntimeTurnRecord> {
		const turnId = this.#runtime.continuationTurnId();
		if (!turnId) return await operation();
		return await this.#withLease(turnId, signal, operation);
	}

	async #withLease(
		turnId: string,
		signal: AbortSignal,
		operation: () => Promise<RuntimeTurnRecord>,
	): Promise<RuntimeTurnRecord> {
		if (this.#activeRun) throw new Error("root_agent_runtime_already_running");
		const lease = await this.#pool.acquire({
			priority: "interactive",
			source: "root",
			sessionId: this.#sessionId,
			turnId,
			signal,
		});
		try {
			signal.throwIfAborted();
		} catch (error) {
			await lease.release();
			throw error;
		}
		let releaseRun!: () => void;
		const released = new Promise<void>((resolve) => { releaseRun = resolve; });
		let resolveForcedResult!: (record: RuntimeTurnRecord) => void;
		const forcedResult = new Promise<RuntimeTurnRecord>((resolve) => { resolveForcedResult = resolve; });
		const operationPromise = Promise.resolve().then(() => {
			this.#runtime.bindProviderStepExecutor(new WorkerProviderStepExecutor({ lease }));
			return operation();
		});
		const active: ActiveRootRun = {
			lease,
			turnId,
			operation: operationPromise,
			released,
			resolveForcedResult,
		};
		this.#activeRun = active;
		try {
			return await Promise.race([operationPromise, forcedResult]);
		} finally {
			try {
				if (active.fenced && active.forceInterrupt) {
					await active.forceInterrupt.catch(() => undefined);
				} else {
					await lease.release();
				}
			} finally {
				if (this.#activeRun === active) {
					this.#runtime.bindProviderStepExecutor(undefined);
					this.#activeRun = undefined;
				}
				releaseRun();
			}
		}
	}

	async #interruptActiveRun(
		active: ActiveRootRun,
		input: ForceInterruptInput,
		emit: (event: RuntimeEvent) => void,
	): Promise<RuntimeTurnRecord> {
		if (await settlementWithin(
			active.operation,
			this.#cooperativeInterruptTimeoutMs,
		) !== "timeout") {
			const result = await this.#runtime.forceInterrupt(input, emit);
			await active.released;
			return result;
		}

		active.fenced = true;
		await active.lease.fence("root turn interruption");
		const cleanup = this.#runtime.forceInterrupt(input, emit);
		const cleaned = await resultWithin(cleanup, this.#coordinatorCleanupTimeoutMs);
		if (cleaned?.status !== "interrupted") {
			await active.lease.terminate("root turn interruption");
			if (cleaned && cleaned.status !== "in_progress") {
				active.resolveForcedResult(cleaned);
				return cleaned;
			}
			const recovered = await this.#recoverInterrupt?.(input);
			if (!recovered
				|| recovered.client_turn_id !== input.clientTurnId
				|| recovered.turn_id !== input.turnId
				|| recovered.status !== "interrupted") {
				throw new Error("root_agent_runtime_interrupt_cleanup_unavailable");
			}
			active.resolveForcedResult(recovered);
			return recovered;
		}
		await active.lease.terminate("root turn interruption");
		// Fenced work can settle late; durable interruption ends the owned run now.
		active.resolveForcedResult(cleaned);
		return cleaned;
	}
}

async function resultWithin<Result>(
	operation: Promise<Result>,
	timeoutMs: number,
): Promise<Result | undefined> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), timeoutMs);
			}),
		]);
	} catch {
		return undefined;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function interruptTimeout(value: number | undefined, fallback: number): number {
	const selected = value ?? fallback;
	if (!Number.isSafeInteger(selected) || selected <= 0 || selected > MAX_INTERRUPT_TIMEOUT_MS) {
		throw new TypeError("invalid root Agent Worker interruption timeout");
	}
	return selected;
}

function requiredIdentity(value: string, label: string): string {
	if (!value.trim() || value.length > 256) throw new TypeError(`${label} is invalid`);
	return value;
}
