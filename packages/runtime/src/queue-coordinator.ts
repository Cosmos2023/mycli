import { createHash } from "node:crypto";
import {
	claimPendingSteers,
	clearQueue,
	enqueueFollowUp as enqueueFollowUpState,
	enqueueSteer as enqueueSteerState,
	markQueuedInputStarted,
	nextQueuedInput,
	popLastFollowUp,
	QueueConflictError,
	rejectPendingSteers,
	restoreQueue,
} from "@mycli/core";
import type {
	QueueClearResult,
	QueueMutation,
	QueueRemoval,
	QueueSnapshot,
	QueuedInput,
} from "@mycli/core";
import { NO_RUNTIME_FAILPOINT } from "./fault-injection.ts";
import type { RuntimeFailpointHook } from "./fault-injection.ts";

export interface QueueCoordinatorStore {
	loadCommittedQueueIds(): ReadonlySet<string>;
	saveSnapshot(snapshot: QueueSnapshot): void;
	commitPending(turnId: string, records: readonly QueuedInput[]): QueueSnapshot;
}

export interface QueueSteerInput {
	readonly sessionId?: string;
	readonly clientTurnId: string;
	readonly expectedTurnId: string;
	readonly activeTurnId: string | null;
	readonly steerable: boolean;
	readonly text: string;
	readonly imagePaths?: readonly string[];
	readonly source?: string;
}

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

export interface QueueCoordinatorOptions {
	readonly initial: QueueSnapshot;
	readonly store: QueueCoordinatorStore;
	readonly activeTurnId: string | null;
	readonly createQueueId: () => string;
	readonly clock: () => string;
	readonly publish?: (snapshot: QueueSnapshot) => void;
	readonly failpoint?: RuntimeFailpointHook;
}

export type QueueListener = (snapshot: QueueSnapshot) => void;

export class QueueCoordinator {
	readonly #store: QueueCoordinatorStore;
	readonly #createQueueId: () => string;
	readonly #clock: () => string;
	readonly #failpoint: RuntimeFailpointHook;
	readonly #listeners = new Set<QueueListener>();
	#snapshot: QueueSnapshot;

	constructor(options: QueueCoordinatorOptions) {
		this.#store = options.store;
		this.#createQueueId = options.createQueueId;
		this.#clock = options.clock;
		this.#failpoint = options.failpoint ?? NO_RUNTIME_FAILPOINT;
		if (options.publish) this.#listeners.add(options.publish);
		const restored = restoreQueue(options.initial, {
			committedQueueIds: options.store.loadCommittedQueueIds(),
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
			queueId: this.#createQueueId(),
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
		const next = this.#store.commitPending(turnId, records);
		this.#acceptPersisted(next);
		return records;
	}

	rejectPending(turnId: string): QueueSnapshot {
		return this.#persist(rejectPendingSteers(this.#snapshot, turnId, this.#clock()));
	}

	next(): QueuedInput | undefined {
		return nextQueuedInput(this.#snapshot);
	}

	markStarted(queueId: string): QueueSnapshot {
		return this.#persist(markQueuedInputStarted(this.#snapshot, queueId));
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

	legacyMigration(): LegacyQueueMigration | undefined {
		const records = activeRecords(this.#snapshot).filter(
			(record) => record.source !== "task_notification",
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

function migrationToken(revision: number, records: readonly QueuedInput[]): string {
	const identity = records.map(
		(record) => `${record.queueId}\0${record.kind}\0${record.updatedAt}`,
	).join("\n");
	return createHash("sha256").update(`${revision}\n${identity}`).digest("hex");
}

function activeRecords(snapshot: QueueSnapshot): QueuedInput[] {
	return [...snapshot.pendingSteers, ...snapshot.rejectedSteers, ...snapshot.followUps];
}

function nextRevision(revision: number): number {
	if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) {
		throw new RangeError("queue revision cannot be incremented safely");
	}
	return revision + 1;
}
