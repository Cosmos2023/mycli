import { parseRuntimeState, type RuntimeStateRecord, type RuntimeTurnRecord } from "@mycli/contracts";
import { modelInputSha256, type CanonicalMessage, type CanonicalToolCall, type RuntimeEvent } from "@mycli/core";
import { StorageFailure, type RuntimeSessionStore } from "@mycli/storage";
import { fileMutationApprovalPreview, shellApprovalPreview } from "@mycli/tools";
import {
	ApprovalNotPendingError,
	type ApprovalChoice,
	type ApprovalContinuationCoordinator,
	type PendingApprovalContinuation,
} from "./approval-continuation-coordinator.ts";

type SuspendedState = Extract<RuntimeStateRecord, { kind: "suspended_turn" }>;
type Batch = NonNullable<SuspendedState["payload"]["parallel_batch"]>;
type BatchCall = Batch["calls"][number];

export interface ParallelApprovalCall {
	readonly call: CanonicalToolCall;
	readonly executionCall: CanonicalToolCall;
	readonly sandboxOverrideApproved: boolean;
	readonly approval?: PendingApprovalContinuation;
}

interface RestoredParallelApprovalBatch {
	readonly continuation: PendingApprovalContinuation;
	readonly calls: readonly ParallelApprovalCall[];
	readonly pendingCallIds: ReadonlySet<string>;
}

interface ParallelApprovalCoordinatorOptions {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly store: Pick<RuntimeSessionStore,
		| "loadState" | "saveParallelApprovalBatch" | "clearParallelApprovalBatch"
		| "loadTurn" | "loadPendingToolCalls" | "recoverInterruptedTurn" | "agentEffectLedger">;
	readonly approval: Pick<ApprovalContinuationCoordinator, "prepare" | "serialize" | "restore" | "authorize">;
}

interface ApprovalWaiter {
	readonly promise: Promise<ApprovalChoice>;
	readonly resolve: (choice: ApprovalChoice) => void;
	readonly reject: (error: Error) => void;
}

interface ActiveBatch {
	state: SuspendedState;
	aborted: boolean;
	readonly signal: AbortSignal;
	readonly emit: (event: RuntimeEvent) => void;
	readonly waiters: ReadonlyMap<string, ApprovalWaiter>;
	readonly onAbort: () => void;
	published?: string;
}

export class ParallelApprovalCoordinator {
	readonly #options: ParallelApprovalCoordinatorOptions;
	#active: ActiveBatch | undefined;

	constructor(options: ParallelApprovalCoordinatorOptions) {
		this.#options = options;
	}

	prepare(input: Parameters<ApprovalContinuationCoordinator["prepare"]>[0]): PendingApprovalContinuation {
		return this.#options.approval.prepare(input);
	}

	begin(input: {
		readonly calls: readonly ParallelApprovalCall[];
		readonly continuation: PendingApprovalContinuation;
		readonly conversation: readonly CanonicalMessage[];
		readonly signal: AbortSignal;
		readonly emit: (event: RuntimeEvent) => void;
	}): void {
		input.signal.throwIfAborted();
		if (this.#active) throw new StorageFailure("parallel approval batch is already active");
		if (input.calls.length === 0) throw new StorageFailure("parallel approval batch is empty");
		const serialized = this.#options.approval.serialize(input.continuation, input.conversation);
		this.#save({
			...serialized.suspendedTurn,
			payload: {
				...serialized.suspendedTurn.payload,
				parallel_batch: {
					batch_id: input.calls[0]!.call.callId,
					revision: 0,
					calls: nonEmptyCalls(input.calls.map((entry) => ({
						call: { ...entry.call },
						execution_call: { ...entry.executionCall },
						sandbox_override_approved: entry.sandboxOverrideApproved,
						...(entry.approval ? {
							approval: this.#options.approval.serialize(entry.approval, []).pendingDecision.payload,
						} : {}),
					}))),
				},
			},
		});
		this.#activate(this.#requiredState(), input.signal, input.emit);
	}

	pending(): PendingApprovalContinuation | undefined {
		const state = this.#load();
		const entry = state?.payload.parallel_batch?.calls.find(
			(call) => call.approval && call.choice === undefined,
		);
		return state && entry ? this.#pending(state, entry) : undefined;
	}

	restore(signal: AbortSignal, emit: (event: RuntimeEvent) => void): RestoredParallelApprovalBatch {
		if (this.#active) throw new StorageFailure("parallel approval batch is already active");
		const state = this.#requiredState();
		const batch = state.payload.parallel_batch!;
		const head = batch.calls.find((entry) => entry.approval && entry.choice === undefined);
		if (!head) throw new ApprovalNotPendingError();
		const continuation = this.#pending(state, head);
		const calls = batch.calls.map((entry): ParallelApprovalCall => ({
			call: entry.call,
			executionCall: entry.execution_call,
			sandboxOverrideApproved: entry.sandbox_override_approved,
			...(entry.approval ? { approval: this.#pending(state, entry) } : {}),
		}));
		const pendingCallIds = new Set(this.#options.store.loadPendingToolCalls(
			this.#options.sessionId, continuation.turnId,
		).map((call) => call.callId));
		this.#activate(state, signal, emit, false);
		return { continuation, calls, pendingCallIds };
	}

	hasActiveApproval(decisionId: string): boolean {
		return this.#active !== undefined && !this.#active.aborted && !this.#active.signal.aborted
			&& this.#active.state.payload.parallel_batch!.calls.some(
				(entry) => entry.call.callId === decisionId && entry.approval && entry.choice === undefined,
			);
	}

	respond(input: { readonly decisionId: string; readonly choice: ApprovalChoice }): void {
		const active = this.#active;
		if (!active || !this.hasActiveApproval(input.decisionId)) throw new ApprovalNotPendingError();
		const batch = active.state.payload.parallel_batch!;
		const entry = batch.calls.find((call) => call.call.callId === input.decisionId)!;
		if (!entry.approval?.options.includes(input.choice)) throw new ApprovalNotPendingError();
		const next: SuspendedState = {
			...active.state,
			payload: {
				...active.state.payload,
				parallel_batch: {
					...batch,
					revision: batch.revision + 1,
					calls: nonEmptyCalls(batch.calls.map((call) => call === entry ? { ...call, choice: input.choice } : call)),
				},
			},
		};
		this.#save(next, batch.revision);
		active.state = this.#requiredState();
		queueMicrotask(() => {
			if (this.#active !== active || active.aborted || active.signal.aborted) return;
			this.#publishNext(active);
			active.waiters.get(input.decisionId)?.resolve(input.choice);
		});
	}

	async waitForApproval(callId: string): Promise<boolean> {
		const active = this.#active;
		const entry = active?.state.payload.parallel_batch!.calls.find((call) => call.call.callId === callId);
		if (!active || !entry?.approval) throw new ApprovalNotPendingError();
		assertActive(active);
		const choice = entry.choice ?? await active.waiters.get(callId)!.promise;
		assertActive(active);
		if (choice === "reject") return false;
		await this.#options.approval.authorize(this.#pending(active.state, entry), choice);
		assertActive(active);
		return true;
	}

	finish(): void {
		const active = this.#active;
		if (!active) return;
		this.#active = undefined;
		active.signal.removeEventListener("abort", active.onAbort);
		active.onAbort();
		this.#options.store.clearParallelApprovalBatch(
			this.#options.sessionId, active.state.payload.turn_id!, active.state.payload.parallel_batch!.batch_id,
		);
	}

	abortPending(): void {
		this.#active?.onAbort();
	}

	recover(): RuntimeTurnRecord | undefined {
		if (this.#active) return undefined;
		const state = this.#load();
		if (!state) return undefined;
		const turnId = state.payload.turn_id!;
		const turn = this.#options.store.loadTurn(this.#options.sessionId, state.payload.client_turn_id!);
		if (!turn || turn.turn_id !== turnId) throw new StorageFailure("parallel approval turn is invalid");
		const batch = state.payload.parallel_batch!;
		const unknownEffect = batch.calls.some((entry) => {
			const attempt = this.#options.store.agentEffectLedger.load(toolEffectAttemptId(
				this.#options.sessionId, turnId, entry.call.callId,
			));
			return attempt !== undefined && attempt.state !== "completed";
		});
		if (turn.status === "in_progress" && !unknownEffect && this.pending()) return undefined;
		const recovered = turn.status === "in_progress"
			? this.#options.store.recoverInterruptedTurn(this.#options.sessionId, turnId)
			: turn;
		this.#options.store.clearParallelApprovalBatch(this.#options.sessionId, turnId, batch.batch_id);
		return recovered;
	}

	#activate(
		state: SuspendedState,
		signal: AbortSignal,
		emit: (event: RuntimeEvent) => void,
		publish = true,
	): void {
		signal.throwIfAborted();
		const waiters = new Map<string, ApprovalWaiter>();
		for (const entry of state.payload.parallel_batch!.calls) {
			if (!entry.approval || entry.choice !== undefined) continue;
			let resolve!: ApprovalWaiter["resolve"];
			let reject!: ApprovalWaiter["reject"];
			const promise = new Promise<ApprovalChoice>((accept, fail) => { resolve = accept; reject = fail; });
			void promise.catch(() => undefined);
			waiters.set(entry.call.callId, { promise, resolve, reject });
		}
		const onAbort = (): void => {
			active.aborted = true;
			for (const waiter of waiters.values()) waiter.reject(new DOMException("Turn interrupted", "AbortError"));
		};
		const active: ActiveBatch = { state, signal, emit, waiters, onAbort, aborted: false };
		this.#active = active;
		signal.addEventListener("abort", onAbort, { once: true });
		if (publish) queueMicrotask(() => {
			if (this.#active === active && !active.aborted && !signal.aborted) this.#publishNext(active);
		});
	}

	#publishNext(active: ActiveBatch): void {
		const entry = active.state.payload.parallel_batch!.calls.find(
			(call) => call.approval && call.choice === undefined,
		);
		if (!entry || active.published === entry.call.callId) return;
		const pending = this.#pending(active.state, entry);
		active.published = pending.decisionId;
		active.emit({
			type: "approval_requested",
			clientTurnId: pending.clientTurnId,
			turnId: pending.turnId,
			decisionId: pending.decisionId,
			callId: pending.callId,
			toolName: pending.toolName,
			preview: pending.preview,
			reason: pending.reason,
			options: pending.options,
			...fileMutationApprovalPreview(pending.call),
			...shellApprovalPreview(pending.call),
		});
	}

	#pending(state: SuspendedState, entry: BatchCall): PendingApprovalContinuation {
		if (!entry.approval) throw new ApprovalNotPendingError();
		const pending = this.#options.approval.restore({
			kind: "pending_decision", version: 1, payload: entry.approval,
		}, { ...state, payload: { ...state.payload, pending_approval: entry.approval } });
		return Object.freeze({ ...pending, call: Object.freeze({ ...entry.call }) });
	}

	#save(state: SuspendedState, expectedRevision?: number): void {
		this.#options.store.saveParallelApprovalBatch({
			sessionId: this.#options.sessionId,
			workspaceRoot: this.#options.workspaceRoot,
			threadId: this.#options.threadId,
			suspendedTurn: state,
			...(expectedRevision !== undefined ? { expectedRevision } : {}),
		});
	}

	#load(): SuspendedState | undefined {
		const payload = this.#options.store.loadState(this.#options.sessionId, "suspended_turn");
		if (payload === undefined) return undefined;
		const state = parseRuntimeState({ kind: "suspended_turn", version: 1, payload });
		return state.kind === "suspended_turn" && state.payload.parallel_batch ? state : undefined;
	}

	#requiredState(): SuspendedState {
		const state = this.#load();
		if (!state) throw new ApprovalNotPendingError();
		return state;
	}
}

export function toolEffectAttemptId(sessionId: string, turnId: string, callId: string): string {
	return `attempt-${modelInputSha256({ session_id: sessionId, turn_id: turnId, call_id: callId })}`;
}

function nonEmptyCalls(calls: readonly BatchCall[]): Batch["calls"] {
	const [first, ...rest] = calls;
	if (!first) throw new StorageFailure("parallel approval batch is empty");
	return [first, ...rest];
}

function assertActive(active: ActiveBatch): void {
	active.signal.throwIfAborted();
	if (active.aborted) throw new DOMException("Turn interrupted", "AbortError");
}
