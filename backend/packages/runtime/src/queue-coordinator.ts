import { createHash } from "node:crypto";
import {
	claimQueueForRestoration,
	claimQueuedInput,
	claimPendingSteers,
	clearQueue,
	enqueueFollowUp as enqueueFollowUpState,
	enqueueSteer as enqueueSteerState,
	markQueuedInputStarted,
	nextQueuedInput,
	popLastFollowUp,
	preparePendingSteersForResubmit,
	QueueConflictError,
	rejectPendingSteers,
	releaseQueueRestorationClaims,
	releaseQueuedInputClaim,
	retireQueueRestorationClaim,
	retireQueuedInputClaim,
	restoreQueue,
} from "@mycli/core";
import type {
	CanonicalImage,
	QueueClearResult,
	QueueMutation,
	QueueRemoval,
	QueueRestorationClaim,
	QueueSnapshot,
	QueueSteerResubmitResult,
	QueuedInput,
} from "@mycli/core";
import { NO_RUNTIME_FAILPOINT } from "./fault-injection.ts";
import type { RuntimeFailpointHook } from "./fault-injection.ts";

export interface QueueCoordinatorStore {
	loadCommittedQueueIds(): ReadonlySet<string>;
	saveSnapshot(snapshot: QueueSnapshot): void;
	commitPending(
		turnId: string,
		records: readonly QueuedInput[],
		imagesByQueueId?: ReadonlyMap<string, readonly CanonicalImage[]>,
	): QueueSnapshot;
}

export interface QueueSteerInput {
	readonly queueId?: string;
	readonly sessionId?: string;
	readonly clientTurnId: string;
	readonly expectedTurnId: string;
	readonly activeTurnId: string | null;
	readonly steerable: boolean;
	readonly text: string;
	readonly imagePaths?: readonly string[];
	readonly source?: string;
}

export interface QueueTaskNotificationInput {
	readonly sessionId?: string;
	readonly taskId: string;
	readonly text: string;
}

export interface QueueInternalNotificationInput {
	readonly sessionId?: string;
	readonly queueId: string;
	readonly text: string;
	readonly source: "task_notification" | "agent_mailbox";
}

export interface QueueTaskNotificationResult {
	readonly disposition: "queued" | "duplicate";
	readonly queueId: string;
}

export interface QueueActivityWaitInput {
	readonly turnId: string;
	readonly timeoutMs: number;
	readonly signal: AbortSignal;
}

export type QueueActivityKind = "steering" | "task_notification" | "agent_message" | "mixed";

export type QueueActivityWaitResult =
	| {
		readonly kind: "activity";
		readonly activity: QueueActivityKind;
		readonly pendingCount: number;
	}
	| { readonly kind: "timeout" };

export interface QueueFollowUpInput {
	readonly sessionId?: string;
	readonly clientTurnId: string;
	readonly text: string;
	readonly imagePaths?: readonly string[];
	readonly source?: string;
}

export interface LegacyQueueMigration {
	readonly token: string;
	readonly records: readonly QueuedInput[];
}

export interface QueueClaimReconciliation {
	readonly committed: boolean;
	readonly snapshot: QueueSnapshot;
}

export interface QueueCoordinatorOptions {
	readonly initial: QueueSnapshot;
	readonly store: QueueCoordinatorStore;
	readonly activeTurnId: string | null;
	readonly createQueueId: () => string;
	readonly clock: () => string;
	readonly publish?: (snapshot: QueueSnapshot) => void;
	readonly onCommitted?: (records: readonly QueuedInput[]) => void;
	readonly loadLocalImages?: (paths: readonly string[]) => readonly CanonicalImage[];
	readonly failpoint?: RuntimeFailpointHook;
}

export type QueueListener = (snapshot: QueueSnapshot) => void;

export class QueueCoordinator {
	readonly #store: QueueCoordinatorStore;
	readonly #createQueueId: () => string;
	readonly #clock: () => string;
	readonly #failpoint: RuntimeFailpointHook;
	readonly #onCommitted?: (records: readonly QueuedInput[]) => void;
	readonly #loadLocalImages?: (paths: readonly string[]) => readonly CanonicalImage[];
	readonly #listeners = new Set<QueueListener>();
	readonly #committedQueueIds: Set<string>;
	#snapshot: QueueSnapshot;

	constructor(options: QueueCoordinatorOptions) {
		this.#store = options.store;
		this.#createQueueId = options.createQueueId;
		this.#clock = options.clock;
		this.#failpoint = options.failpoint ?? NO_RUNTIME_FAILPOINT;
		this.#onCommitted = options.onCommitted;
		this.#loadLocalImages = options.loadLocalImages;
		if (options.publish) this.#listeners.add(options.publish);
		this.#committedQueueIds = new Set(options.store.loadCommittedQueueIds());
		const restored = restoreQueue(options.initial, {
			committedQueueIds: this.#committedQueueIds,
			activeTurnId: options.activeTurnId,
			now: options.clock(),
		});
		if (restored.revision !== options.initial.revision) options.store.saveSnapshot(restored);
		this.#snapshot = restored;
	}

	snapshot(): QueueSnapshot {
		return this.#snapshot;
	}

	subscribe(listener: QueueListener): () => void {
		this.#listeners.add(listener);
		return () => { this.#listeners.delete(listener); };
	}

	enqueueSteer(input: QueueSteerInput): QueueMutation {
		const mutation = enqueueSteerState(this.#snapshot, {
			queueId: input.queueId ?? this.#createQueueId(),
			...(input.sessionId ? { sessionId: input.sessionId } : {}),
			clientTurnId: input.clientTurnId,
			expectedTurnId: input.expectedTurnId,
			activeTurnId: input.activeTurnId,
			steerable: input.steerable,
			text: input.text,
			imagePaths: input.imagePaths,
			source: input.source ?? "user",
			now: this.#clock(),
		});
		this.#persistMutation(mutation);
		return mutation;
	}

	enqueueTaskNotification(input: QueueTaskNotificationInput): QueueTaskNotificationResult {
		const queueId = taskNotificationQueueId(input.taskId);
		return this.enqueueInternalNotification({
			...(input.sessionId ? { sessionId: input.sessionId } : {}),
			queueId,
			text: input.text,
			source: "task_notification",
		});
	}

	enqueueInternalNotification(
		input: QueueInternalNotificationInput,
	): QueueTaskNotificationResult {
		const queueId = requiredValue(input.queueId, "queueId");
		if (this.#committedQueueIds.has(queueId)
			|| activeRecords(this.#snapshot).some((record) => record.queueId === queueId)) {
			return Object.freeze({ disposition: "duplicate", queueId });
		}
		this.enqueueSteer({
			queueId,
			...(input.sessionId ? { sessionId: input.sessionId } : {}),
			clientTurnId: queueId,
			expectedTurnId: "turn_pending",
			activeTurnId: "turn_pending",
			steerable: true,
			text: input.text,
			source: input.source,
		});
		return Object.freeze({ disposition: "queued", queueId });
	}

	waitForActivity(input: QueueActivityWaitInput): Promise<QueueActivityWaitResult> {
		const turnId = requiredValue(input.turnId, "turnId");
		if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
			throw new RangeError("timeoutMs must be a positive safe integer");
		}
		if (input.signal.aborted) return Promise.reject(abortError());
		const existing = activityForTurn(this.#snapshot, turnId);
		if (existing) return Promise.resolve(existing);

		return new Promise<QueueActivityWaitResult>((resolve, reject) => {
			let settled = false;
			let unsubscribe: () => void = () => undefined;
			const timer = setTimeout(
				() => finish(Object.freeze({ kind: "timeout" })),
				input.timeoutMs,
			);
			const cleanup = (): void => {
				clearTimeout(timer);
				unsubscribe();
				input.signal.removeEventListener("abort", onAbort);
			};
			const finish = (result: QueueActivityWaitResult): void => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			};
			const onAbort = (): void => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(abortError());
			};

			unsubscribe = this.subscribe((snapshot) => {
				const activity = activityForTurn(snapshot, turnId);
				if (activity) finish(activity);
			});
			input.signal.addEventListener("abort", onAbort, { once: true });
			const raced = activityForTurn(this.#snapshot, turnId);
			if (raced) finish(raced);
		});
	}

	enqueueFollowUp(input: QueueFollowUpInput): QueueMutation {
		const mutation = enqueueFollowUpState(this.#snapshot, {
			queueId: this.#createQueueId(),
			...(input.sessionId ? { sessionId: input.sessionId } : {}),
			clientTurnId: input.clientTurnId,
			text: input.text,
			imagePaths: input.imagePaths,
			source: input.source ?? "user",
			now: this.#clock(),
		});
		this.#persistMutation(mutation);
		return mutation;
	}

	commitPending(turnId: string): readonly QueuedInput[] {
		const records = claimPendingSteers(this.#snapshot, turnId);
		if (records.length === 0) return Object.freeze([]);
		const imagesByQueueId = this.#loadQueuedImages(records);
		const next = this.#store.commitPending(turnId, records, imagesByQueueId);
		for (const record of records) this.#committedQueueIds.add(record.queueId);
		this.#acceptPersisted(next);
		try {
			this.#onCommitted?.(records);
		} catch {
			// Queue commit is authoritative even if a mailbox projection listener fails.
		}
		return records;
	}

	#loadQueuedImages(
		records: readonly QueuedInput[],
	): ReadonlyMap<string, readonly CanonicalImage[]> | undefined {
		const withImages = records.filter((record) => record.imagePaths.length > 0);
		if (withImages.length === 0) return undefined;
		if (!this.#loadLocalImages) throw new Error("queued image loader is not configured");
		try {
			return new Map(withImages.map((record) => [
				record.queueId,
				this.#loadLocalImages!(record.imagePaths),
			]));
		} catch {
			throw new QueueImageInputError();
		}
	}

	rejectPending(turnId: string): QueueSnapshot {
		return this.#persist(rejectPendingSteers(this.#snapshot, turnId, this.#clock()));
	}

	prepareInterruptedSteers(turnId: string): QueueSteerResubmitResult {
		const result = preparePendingSteersForResubmit(
			this.#snapshot,
			turnId,
			this.#clock(),
		);
		this.#persist(result.snapshot);
		return result;
	}

	next(): QueuedInput | undefined {
		return nextQueuedInput(this.#snapshot);
	}

	markStarted(queueId: string): QueueSnapshot {
		return this.#persist(markQueuedInputStarted(this.#snapshot, queueId));
	}

	claim(queueId: string, turnId: string): QueueSnapshot {
		return this.#persist(claimQueuedInput(this.#snapshot, queueId, turnId, this.#clock()));
	}

	releaseClaim(queueId: string, turnId: string): QueueSnapshot {
		return this.#persist(releaseQueuedInputClaim(
			this.#snapshot,
			queueId,
			turnId,
			this.#clock(),
		));
	}

	retireClaim(queueId: string, turnId: string): QueueSnapshot {
		const next = this.#persist(retireQueuedInputClaim(this.#snapshot, queueId, turnId));
		this.#committedQueueIds.add(queueId);
		return next;
	}

	reconcileClaim(queueId: string, turnId: string): QueueClaimReconciliation {
		const committed = this.#store.loadCommittedQueueIds();
		for (const committedQueueId of committed) this.#committedQueueIds.add(committedQueueId);
		const wasCommitted = committed.has(queueId);
		return Object.freeze({
			committed: wasCommitted,
			snapshot: wasCommitted
				? this.retireClaim(queueId, turnId)
				: this.releaseClaim(queueId, turnId),
		});
	}

	popLastFollowUp(): QueueRemoval {
		const removal = popLastFollowUp(this.#snapshot);
		this.#persist(removal.snapshot);
		return removal;
	}

	clear(): QueueClearResult {
		const result = clearQueue(this.#snapshot);
		this.#persist(result.snapshot);
		return result;
	}

	claimForRestoration(token: string): QueueRestorationClaim {
		const claim = claimQueueForRestoration(this.#snapshot, token, this.#clock());
		const snapshot = this.#persist(claim.snapshot);
		return Object.freeze({ ...claim, snapshot });
	}

	acknowledgeRestoration(token: string): QueueSnapshot {
		return this.#persist(retireQueueRestorationClaim(this.#snapshot, token));
	}

	releaseRestorationClaims(): QueueSnapshot {
		return this.#persist(releaseQueueRestorationClaims(this.#snapshot, this.#clock()));
	}

	legacyMigration(): LegacyQueueMigration | undefined {
		const records = activeRecords(this.#snapshot).filter(
			(record) => record.state !== "claimed"
				&& record.source !== "task_notification"
				&& record.source !== "agent_mailbox",
		);
		if (records.length === 0) return undefined;
		return Object.freeze({
			token: migrationToken(this.#snapshot.revision, records),
			records: Object.freeze(records),
		});
	}

	acknowledgeLegacyMigration(token: string): QueueSnapshot {
		const migration = this.legacyMigration();
		if (!migration || !token.trim() || token.trim() !== migration.token) {
			throw new QueueConflictError("legacy queue migration token is stale");
		}
		const removeIds = new Set(migration.records.map((record) => record.queueId));
		return this.#persist(Object.freeze({
			sessionId: this.#snapshot.sessionId,
			revision: nextRevision(this.#snapshot.revision),
			pendingSteers: Object.freeze(this.#snapshot.pendingSteers.filter(
				(record) => !removeIds.has(record.queueId),
			)),
			rejectedSteers: Object.freeze(this.#snapshot.rejectedSteers.filter(
				(record) => !removeIds.has(record.queueId),
			)),
			followUps: Object.freeze(this.#snapshot.followUps.filter(
				(record) => !removeIds.has(record.queueId),
			)),
		}));
	}

	#persistMutation(mutation: QueueMutation): void {
		if (mutation.snapshot === this.#snapshot) return;
		this.#persist(mutation.snapshot);
	}

	#persist(candidate: QueueSnapshot): QueueSnapshot {
		if (candidate === this.#snapshot) return this.#snapshot;
		this.#failpoint("queue_before_save");
		this.#store.saveSnapshot(candidate);
		this.#failpoint("queue_after_save");
		this.#acceptPersisted(candidate);
		return candidate;
	}

	#acceptPersisted(snapshot: QueueSnapshot): void {
		if (snapshot.sessionId !== this.#snapshot.sessionId) {
			throw new QueueConflictError("persisted queue belongs to another session");
		}
		this.#snapshot = snapshot;
		for (const listener of this.#listeners) {
			try {
				listener(snapshot);
			} catch {
				// Queue durability must not depend on a projection listener.
			}
		}
	}
}

class QueueImageInputError extends Error {
	readonly code = "unsupported_capability" as const;
	readonly retryable = false;

	constructor() {
		super("queued image attachment is unavailable");
	}
}

function migrationToken(revision: number, records: readonly QueuedInput[]): string {
	const identity = records.map(
		(record) => `${record.queueId}\0${record.kind}\0${record.updatedAt}`,
	).join("\n");
	return createHash("sha256").update(`${revision}\n${identity}`).digest("hex");
}

function activeRecords(snapshot: QueueSnapshot): QueuedInput[] {
	return [...snapshot.pendingSteers, ...snapshot.rejectedSteers, ...snapshot.followUps];
}

function taskNotificationQueueId(taskId: string): string {
	const normalized = requiredValue(taskId, "taskId");
	return `task-notification:${createHash("sha256").update(normalized).digest("hex")}`;
}

function activityForTurn(
	snapshot: QueueSnapshot,
	turnId: string,
): Extract<QueueActivityWaitResult, { readonly kind: "activity" }> | undefined {
	const pending = snapshot.pendingSteers.filter((record) =>
		record.targetTurnId === turnId || record.targetTurnId === "turn_pending"
	);
	if (pending.length === 0) return undefined;
	const notificationCount = pending.filter(
		(record) => record.source === "task_notification",
	).length;
	const agentMessageCount = pending.filter(
		(record) => record.source === "agent_mailbox",
	).length;
	const activity: QueueActivityKind = notificationCount === pending.length
		? "task_notification"
		: agentMessageCount === pending.length
			? "agent_message"
			: notificationCount === 0 && agentMessageCount === 0
				? "steering"
				: "mixed";
	return Object.freeze({ kind: "activity", activity, pendingCount: pending.length });
}

function requiredValue(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized) throw new TypeError(`${field} must be non-empty`);
	return normalized;
}

function abortError(): Error {
	const error = new Error("interrupted");
	error.name = "AbortError";
	return error;
}

function nextRevision(revision: number): number {
	if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) {
		throw new RangeError("queue revision cannot be incremented safely");
	}
	return revision + 1;
}
