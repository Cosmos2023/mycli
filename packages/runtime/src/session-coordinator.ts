import type { QueueSnapshot } from "@mycli/core";
import type {
	SessionLineageNode,
	SessionListQuery,
	SessionOverview,
	TranscriptItem,
} from "@mycli/storage";

export type PendingApprovalChoice =
	| "approve_once"
	| "reject"
	| "allow_session"
	| "always_allow";

export interface PendingSessionApproval {
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly turnId: string;
	readonly decisionId: string;
	readonly callId: string;
	readonly toolName: string;
	readonly preview: string;
	readonly reason: string;
	readonly options: readonly PendingApprovalChoice[];
}

export interface PreparedSession<Binding> {
	readonly sessionId: string;
	readonly workspaceRoot: string;
	readonly threadId: string;
	readonly transcript: readonly TranscriptItem[];
	readonly queue: QueueSnapshot;
	readonly pendingApproval?: PendingSessionApproval;
	readonly suspendedTurn: boolean;
	readonly compactionState?: unknown;
	readonly responsesContinuation?: unknown;
	readonly readOnly: boolean;
	readonly binding: Binding;
}

export interface ActiveSessionSnapshot<Binding> extends PreparedSession<Binding> {
	readonly generation: number;
}

export interface SessionGenerationContext {
	readonly sessionId: string;
	readonly generation: number;
}

export interface SessionCoordinatorOptions<Binding> {
	readonly initial: PreparedSession<Binding>;
	readonly prepare: (sessionId: string) => PreparedSession<Binding> | Promise<PreparedSession<Binding>>;
	readonly listSessions: (query?: SessionListQuery) => readonly SessionOverview[];
	readonly loadSessionLineage: (sessionId: string) => readonly SessionLineageNode[];
}

export type SessionTransitionErrorCode =
	| "turn_in_progress"
	| "session_not_found"
	| "session_state_invalid";

export class SessionTransitionError extends Error {
	constructor(readonly code: SessionTransitionErrorCode, message: string) {
		super(`${code}: ${message}`);
		this.name = "SessionTransitionError";
	}
}

export class SessionCoordinator<Binding> {
	readonly #prepareSession: SessionCoordinatorOptions<Binding>["prepare"];
	readonly #listSessions: SessionCoordinatorOptions<Binding>["listSessions"];
	readonly #loadSessionLineage: SessionCoordinatorOptions<Binding>["loadSessionLineage"];
	#snapshot: ActiveSessionSnapshot<Binding>;
	#executing = false;
	#transitioning = false;

	constructor(options: SessionCoordinatorOptions<Binding>) {
		this.#snapshot = activeSnapshot(options.initial, 1);
		this.#prepareSession = options.prepare;
		this.#listSessions = options.listSessions;
		this.#loadSessionLineage = options.loadSessionLineage;
	}

	snapshot(): ActiveSessionSnapshot<Binding> {
		return this.#snapshot;
	}

	context(): SessionGenerationContext {
		return Object.freeze({
			sessionId: this.#snapshot.sessionId,
			generation: this.#snapshot.generation,
		});
	}

	executing(): boolean {
		return this.#executing;
	}

	isCurrent(context: SessionGenerationContext): boolean {
		return context.sessionId === this.#snapshot.sessionId
			&& context.generation === this.#snapshot.generation;
	}

	markExecuting(context: SessionGenerationContext, executing: boolean): boolean {
		if (!this.isCurrent(context)) return false;
		if (executing && this.#transitioning) return false;
		this.#executing = executing;
		return true;
	}

	updateQueue(context: SessionGenerationContext, queue: QueueSnapshot): boolean {
		if (!this.isCurrent(context) || queue.sessionId !== context.sessionId) return false;
		if (queue.revision <= this.#snapshot.queue.revision && queue !== this.#snapshot.queue) {
			return false;
		}
		this.#snapshot = Object.freeze({
			...this.#snapshot,
			queue: freezeQueue(queue),
		});
		return true;
	}

	updatePendingApproval(
		context: SessionGenerationContext,
		pendingApproval: PendingSessionApproval | undefined,
	): boolean {
		if (!this.isCurrent(context)) return false;
		if (pendingApproval && pendingApproval.sessionId !== context.sessionId) return false;
		const snapshot = { ...this.#snapshot };
		delete snapshot.pendingApproval;
		this.#snapshot = Object.freeze({
			...snapshot,
			...(pendingApproval ? { pendingApproval: freezePendingApproval(pendingApproval) } : {}),
		});
		return true;
	}

	listSessions(query: SessionListQuery = {}): readonly SessionOverview[] {
		return this.#listSessions(query);
	}

	loadSessionLineage(sessionId: string): readonly SessionLineageNode[] {
		return this.#loadSessionLineage(nonEmptySessionId(sessionId));
	}

	async inspect(sessionId: string): Promise<PreparedSession<Binding>> {
		const normalized = nonEmptySessionId(sessionId);
		if (normalized === this.#snapshot.sessionId) return this.#snapshot;
		return freezePrepared(await this.#prepareSession(normalized));
	}

	async resume(sessionId: string): Promise<ActiveSessionSnapshot<Binding>> {
		const normalized = nonEmptySessionId(sessionId);
		if (this.#executing || this.#transitioning) {
			throw new SessionTransitionError("turn_in_progress", "an active turn owns the session");
		}
		if (normalized === this.#snapshot.sessionId) return this.#snapshot;
		this.#transitioning = true;
		try {
			const prepared = freezePrepared(await this.#prepareSession(normalized));
			if (this.#executing) {
				throw new SessionTransitionError("turn_in_progress", "an active turn owns the session");
			}
			if (prepared.sessionId !== normalized) {
				throw new SessionTransitionError(
					"session_state_invalid",
					"prepared session identity does not match the requested session",
				);
			}
			if (this.#snapshot.generation === Number.MAX_SAFE_INTEGER) {
				throw new SessionTransitionError("session_state_invalid", "session generation is exhausted");
			}
			this.#snapshot = activeSnapshot(prepared, this.#snapshot.generation + 1);
			return this.#snapshot;
		} finally {
			this.#transitioning = false;
		}
	}
}

function activeSnapshot<Binding>(
	prepared: PreparedSession<Binding>,
	generation: number,
): ActiveSessionSnapshot<Binding> {
	return Object.freeze({ ...freezePrepared(prepared), generation });
}

function freezePrepared<Binding>(prepared: PreparedSession<Binding>): PreparedSession<Binding> {
	const sessionId = nonEmptySessionId(prepared.sessionId);
	if (prepared.queue.sessionId !== sessionId) {
		throw new SessionTransitionError("session_state_invalid", "queue belongs to another session");
	}
	if (prepared.pendingApproval?.sessionId !== undefined
		&& prepared.pendingApproval.sessionId !== sessionId) {
		throw new SessionTransitionError(
			"session_state_invalid",
			"pending approval belongs to another session",
		);
	}
	return Object.freeze({
		...prepared,
		sessionId,
		workspaceRoot: requiredString(prepared.workspaceRoot, "workspaceRoot"),
		threadId: requiredString(prepared.threadId, "threadId"),
		transcript: Object.freeze(prepared.transcript.map((item) => Object.freeze({ ...item }))),
		queue: freezeQueue(prepared.queue),
		...(prepared.pendingApproval ? { pendingApproval: freezePendingApproval(prepared.pendingApproval) } : {}),
	});
}

function freezePendingApproval(approval: PendingSessionApproval): PendingSessionApproval {
	return Object.freeze({
		...approval,
		options: Object.freeze([...approval.options]),
	});
}

function freezeQueue(queue: QueueSnapshot): QueueSnapshot {
	if (Object.isFrozen(queue)
		&& Object.isFrozen(queue.pendingSteers)
		&& Object.isFrozen(queue.rejectedSteers)
		&& Object.isFrozen(queue.followUps)) {
		return queue;
	}
	return Object.freeze({
		...queue,
		pendingSteers: Object.freeze([...queue.pendingSteers]),
		rejectedSteers: Object.freeze([...queue.rejectedSteers]),
		followUps: Object.freeze([...queue.followUps]),
	});
}

function nonEmptySessionId(value: string): string {
	return requiredString(value, "sessionId");
}

function requiredString(value: string, name: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new TypeError(`${name} must be a non-empty string`);
	}
	return value.trim();
}
