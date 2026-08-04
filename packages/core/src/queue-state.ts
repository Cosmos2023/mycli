export type QueueItemKind = "pending_steer" | "rejected_steer" | "follow_up";
export type QueueDeliveryState = "queued" | "accepted" | "committed";
export type QueueDisposition =
	| "accepted_for_turn"
	| "deferred_to_end_of_turn"
	| "queued_follow_up"
	| "duplicate";

export interface QueueCapacity {
	readonly maxRecords: number;
	readonly maxTextBytes: number;
	readonly maxTotalTextBytes: number;
	readonly maxAttachments: number;
}

export interface QueuedInput {
	readonly queueId: string;
	readonly sessionId: string;
	readonly clientTurnId: string;
	readonly targetTurnId: string | null;
	readonly kind: QueueItemKind;
	readonly state: QueueDeliveryState;
	readonly text: string;
	readonly imagePaths: readonly string[];
	readonly source: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface QueueSnapshot {
	readonly sessionId: string;
	readonly revision: number;
	readonly pendingSteers: readonly QueuedInput[];
	readonly rejectedSteers: readonly QueuedInput[];
	readonly followUps: readonly QueuedInput[];
}

export interface QueueMutation {
	readonly disposition: QueueDisposition;
	readonly record: QueuedInput;
	readonly snapshot: QueueSnapshot;
}

export interface EnqueueSteerInput {
	readonly queueId: string;
	readonly sessionId?: string;
	readonly clientTurnId: string;
	readonly expectedTurnId: string;
	readonly activeTurnId: string | null;
	readonly steerable: boolean;
	readonly text: string;
	readonly imagePaths?: readonly string[];
	readonly source: string;
	readonly now: string;
}

export interface EnqueueFollowUpInput {
	readonly queueId: string;
	readonly sessionId?: string;
	readonly clientTurnId: string;
	readonly text: string;
	readonly imagePaths?: readonly string[];
	readonly source: string;
	readonly now: string;
}

export interface RestoreQueueInput {
	readonly committedQueueIds: ReadonlySet<string>;
	readonly activeTurnId: string | null;
	readonly now: string;
	readonly capacity?: Partial<QueueCapacity>;
}

export interface QueueRemoval {
	readonly snapshot: QueueSnapshot;
	readonly record?: QueuedInput;
}

export interface QueueClearResult {
	readonly snapshot: QueueSnapshot;
	readonly records: readonly QueuedInput[];
}

export class QueueConflictError extends Error {
	readonly code = "queue_conflict" as const;

	constructor(message: string) {
		super(message);
		this.name = "QueueConflictError";
	}
}

export class QueueCapacityError extends Error {
	readonly code = "queue_capacity" as const;

	constructor(message: string) {
		super(message);
		this.name = "QueueCapacityError";
	}
}

export const DEFAULT_QUEUE_CAPACITY: QueueCapacity = Object.freeze({
	maxRecords: 128,
	maxTextBytes: 64 * 1024,
	maxTotalTextBytes: 512 * 1024,
	maxAttachments: 16,
});

export function enqueueSteer(
	snapshot: QueueSnapshot,
	input: EnqueueSteerInput,
	capacity: Partial<QueueCapacity> = {},
): QueueMutation {
	const limits = resolveCapacity(capacity);
	validateSnapshot(snapshot, limits);
	validateInputSession(snapshot.sessionId, input.sessionId);
	const clientTurnId = nonEmpty(input.clientTurnId, "clientTurnId");
	const expectedTurnId = nonEmpty(input.expectedTurnId, "expectedTurnId");
	const normalized = normalizedPayload(input.text, input.imagePaths, input.source);
	const duplicate = duplicateOrConflict(snapshot, {
		clientTurnId,
		text: normalized.text,
		imagePaths: normalized.imagePaths,
		targetTurnId: expectedTurnId,
		source: normalized.source,
	});
	if (duplicate) {
		return Object.freeze({ disposition: "duplicate", record: duplicate, snapshot });
	}

	const queueId = availableQueueId(snapshot, input.queueId);
	const activeTurnId = input.activeTurnId === null
		? null
		: nonEmpty(input.activeTurnId, "activeTurnId");
	const accepted = input.steerable
		&& activeTurnId !== null
		&& activeTurnId === expectedTurnId;
	const record = freezeRecord({
		queueId,
		sessionId: snapshot.sessionId,
		clientTurnId,
		targetTurnId: expectedTurnId,
		kind: accepted ? "pending_steer" : "rejected_steer",
		state: accepted ? "accepted" : "queued",
		text: normalized.text,
		imagePaths: normalized.imagePaths,
		source: normalized.source,
		createdAt: nonEmpty(input.now, "now"),
		updatedAt: nonEmpty(input.now, "now"),
	});
	const candidate = freezeSnapshot({
		...snapshot,
		revision: nextRevision(snapshot.revision),
		pendingSteers: accepted
			? [...snapshot.pendingSteers, record]
			: snapshot.pendingSteers,
		rejectedSteers: accepted
			? snapshot.rejectedSteers
			: [...snapshot.rejectedSteers, record],
	});
	validateCapacity(candidate, limits);
	return Object.freeze({
		disposition: accepted ? "accepted_for_turn" : "deferred_to_end_of_turn",
		record,
		snapshot: candidate,
	});
}

export function enqueueFollowUp(
	snapshot: QueueSnapshot,
	input: EnqueueFollowUpInput,
	capacity: Partial<QueueCapacity> = {},
): QueueMutation {
	const limits = resolveCapacity(capacity);
	validateSnapshot(snapshot, limits);
	validateInputSession(snapshot.sessionId, input.sessionId);
	const clientTurnId = nonEmpty(input.clientTurnId, "clientTurnId");
	const normalized = normalizedPayload(input.text, input.imagePaths, input.source);
	const duplicate = duplicateOrConflict(snapshot, {
		clientTurnId,
		text: normalized.text,
		imagePaths: normalized.imagePaths,
		targetTurnId: null,
		source: normalized.source,
	});
	if (duplicate) {
		return Object.freeze({ disposition: "duplicate", record: duplicate, snapshot });
	}

	const record = freezeRecord({
		queueId: availableQueueId(snapshot, input.queueId),
		sessionId: snapshot.sessionId,
		clientTurnId,
		targetTurnId: null,
		kind: "follow_up",
		state: "queued",
		text: normalized.text,
		imagePaths: normalized.imagePaths,
		source: normalized.source,
		createdAt: nonEmpty(input.now, "now"),
		updatedAt: nonEmpty(input.now, "now"),
	});
	const candidate = freezeSnapshot({
		...snapshot,
		revision: nextRevision(snapshot.revision),
		followUps: [...snapshot.followUps, record],
	});
	validateCapacity(candidate, limits);
	return Object.freeze({
		disposition: "queued_follow_up",
		record,
		snapshot: candidate,
	});
}

export function restoreQueue(
	snapshot: QueueSnapshot,
	input: RestoreQueueInput,
): QueueSnapshot {
	const limits = resolveCapacity(input.capacity ?? {});
	validateSnapshot(snapshot, limits);
	const now = nonEmpty(input.now, "now");
	const activeTurnId = input.activeTurnId === null
		? null
		: nonEmpty(input.activeTurnId, "activeTurnId");
	let changed = false;
	const rejected = snapshot.rejectedSteers.filter((record) => {
		const keep = !input.committedQueueIds.has(record.queueId);
		changed ||= !keep;
		return keep;
	});
	const pending: QueuedInput[] = [];
	for (const record of snapshot.pendingSteers) {
		if (input.committedQueueIds.has(record.queueId)) {
			changed = true;
			continue;
		}
		if (activeTurnId === null || record.targetTurnId !== activeTurnId) {
			rejected.push(freezeRecord({
				...record,
				kind: "rejected_steer",
				state: "queued",
				updatedAt: now,
			}));
			changed = true;
			continue;
		}
		pending.push(record);
	}
	const followUps = snapshot.followUps.filter((record) => {
		const keep = !input.committedQueueIds.has(record.queueId);
		changed ||= !keep;
		return keep;
	});
	if (!changed) {
		return freezeSnapshot(snapshot);
	}
	const restored = freezeSnapshot({
		...snapshot,
		revision: nextRevision(snapshot.revision),
		pendingSteers: pending,
		rejectedSteers: rejected,
		followUps,
	});
	validateCapacity(restored, limits);
	return restored;
}

export function claimPendingSteers(
	snapshot: QueueSnapshot,
	turnId: string,
): readonly QueuedInput[] {
	validateSnapshot(snapshot, DEFAULT_QUEUE_CAPACITY);
	const normalizedTurnId = nonEmpty(turnId, "turnId");
	return Object.freeze(snapshot.pendingSteers.filter(
		(record) => record.targetTurnId === normalizedTurnId || record.targetTurnId === "turn_pending",
	));
}

export function rejectPendingSteers(
	snapshot: QueueSnapshot,
	turnId: string,
	now: string,
): QueueSnapshot {
	validateSnapshot(snapshot, DEFAULT_QUEUE_CAPACITY);
	const normalizedTurnId = nonEmpty(turnId, "turnId");
	const matching = snapshot.pendingSteers.filter(
		(record) => record.targetTurnId === normalizedTurnId,
	);
	if (matching.length === 0) {
		return snapshot;
	}
	const matchingIds = new Set(matching.map((record) => record.queueId));
	return freezeSnapshot({
		...snapshot,
		revision: nextRevision(snapshot.revision),
		pendingSteers: snapshot.pendingSteers.filter(
			(record) => !matchingIds.has(record.queueId),
		),
		rejectedSteers: [
			...snapshot.rejectedSteers,
			...matching.map((record) => freezeRecord({
				...record,
				kind: "rejected_steer",
				state: "queued",
				updatedAt: nonEmpty(now, "now"),
			})),
		],
	});
}

export function nextQueuedInput(snapshot: QueueSnapshot): QueuedInput | undefined {
	validateSnapshot(snapshot, DEFAULT_QUEUE_CAPACITY);
	return snapshot.rejectedSteers[0] ?? snapshot.followUps[0];
}

export function markQueuedInputStarted(
	snapshot: QueueSnapshot,
	queueId: string,
): QueueSnapshot {
	validateSnapshot(snapshot, DEFAULT_QUEUE_CAPACITY);
	const expected = nextQueuedInput(snapshot);
	if (!expected || expected.queueId !== nonEmpty(queueId, "queueId")) {
		throw new QueueConflictError("queue id is not the next end-of-turn record");
	}
	return freezeSnapshot({
		...snapshot,
		revision: nextRevision(snapshot.revision),
		rejectedSteers: expected.kind === "rejected_steer"
			? snapshot.rejectedSteers.slice(1)
			: snapshot.rejectedSteers,
		followUps: expected.kind === "follow_up"
			? snapshot.followUps.slice(1)
			: snapshot.followUps,
	});
}

export function popLastFollowUp(snapshot: QueueSnapshot): QueueRemoval {
	validateSnapshot(snapshot, DEFAULT_QUEUE_CAPACITY);
	const record = snapshot.followUps.at(-1);
	if (!record) {
		return Object.freeze({ snapshot });
	}
	return Object.freeze({
		record,
		snapshot: freezeSnapshot({
			...snapshot,
			revision: nextRevision(snapshot.revision),
			followUps: snapshot.followUps.slice(0, -1),
		}),
	});
}

export function clearQueue(snapshot: QueueSnapshot): QueueClearResult {
	validateSnapshot(snapshot, DEFAULT_QUEUE_CAPACITY);
	const records = Object.freeze(activeRecords(snapshot));
	if (records.length === 0) {
		return Object.freeze({ snapshot, records });
	}
	return Object.freeze({
		records,
		snapshot: freezeSnapshot({
			sessionId: snapshot.sessionId,
			revision: nextRevision(snapshot.revision),
			pendingSteers: [],
			rejectedSteers: [],
			followUps: [],
		}),
	});
}

function normalizedPayload(
	text: string,
	imagePaths: readonly string[] | undefined,
	source: string,
): { readonly text: string; readonly imagePaths: readonly string[]; readonly source: string } {
	return {
		text: nonEmpty(text, "text"),
		imagePaths: Object.freeze([...new Set(
			(imagePaths ?? []).map((path) => nonEmpty(path, "imagePath")),
		)]),
		source: nonEmpty(source, "source"),
	};
}

function duplicateOrConflict(
	snapshot: QueueSnapshot,
	input: {
		readonly clientTurnId: string;
		readonly text: string;
		readonly imagePaths: readonly string[];
		readonly targetTurnId: string | null;
		readonly source: string;
	},
): QueuedInput | undefined {
	const existing = activeRecords(snapshot).find(
		(record) => record.clientTurnId === input.clientTurnId,
	);
	if (!existing) {
		return undefined;
	}
	if (
		existing.text === input.text
		&& arraysEqual(existing.imagePaths, input.imagePaths)
		&& existing.targetTurnId === input.targetTurnId
		&& existing.source === input.source
	) {
		return existing;
	}
	throw new QueueConflictError("clientTurnId is already used by different queued input");
}

function availableQueueId(snapshot: QueueSnapshot, value: string): string {
	const queueId = nonEmpty(value, "queueId");
	if (activeRecords(snapshot).some((record) => record.queueId === queueId)) {
		throw new QueueConflictError("queueId is already used by queued input");
	}
	return queueId;
}

function validateInputSession(snapshotSessionId: string, inputSessionId?: string): void {
	if (inputSessionId !== undefined && nonEmpty(inputSessionId, "sessionId") !== snapshotSessionId) {
		throw new QueueConflictError("queued input session does not match snapshot");
	}
}

function validateSnapshot(snapshot: QueueSnapshot, capacity: QueueCapacity): void {
	const sessionId = nonEmpty(snapshot.sessionId, "sessionId");
	if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
		throw new RangeError("revision must be a non-negative safe integer");
	}
	const seenQueueIds = new Set<string>();
	for (const [records, kind] of [
		[snapshot.pendingSteers, "pending_steer"],
		[snapshot.rejectedSteers, "rejected_steer"],
		[snapshot.followUps, "follow_up"],
	] as const) {
		for (const record of records) {
			if (record.sessionId !== sessionId) {
				throw new QueueConflictError("queued input session does not match snapshot");
			}
			if (record.kind !== kind) {
				throw new QueueConflictError(`queue contains ${record.kind} in ${kind} records`);
			}
			if (seenQueueIds.has(record.queueId)) {
				throw new QueueConflictError("queueId is duplicated in queue snapshot");
			}
			seenQueueIds.add(record.queueId);
		}
	}
	validateCapacity(snapshot, capacity);
}

function validateCapacity(snapshot: QueueSnapshot, capacity: QueueCapacity): void {
	const records = activeRecords(snapshot);
	if (records.length > capacity.maxRecords) {
		throw new QueueCapacityError("queue record limit exceeded");
	}
	if (records.some((record) => utf8Length(record.text) > capacity.maxTextBytes)) {
		throw new QueueCapacityError("queue record text limit exceeded");
	}
	if (records.reduce((total, record) => total + utf8Length(record.text), 0)
		> capacity.maxTotalTextBytes) {
		throw new QueueCapacityError("queue aggregate text limit exceeded");
	}
	if (records.some((record) => record.imagePaths.length > capacity.maxAttachments)) {
		throw new QueueCapacityError("queue attachment limit exceeded");
	}
}

function resolveCapacity(input: Partial<QueueCapacity>): QueueCapacity {
	const result = {
		...DEFAULT_QUEUE_CAPACITY,
		...input,
	};
	for (const [name, value] of Object.entries(result)) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new RangeError(`${name} must be a non-negative safe integer`);
		}
	}
	return Object.freeze(result);
}

function freezeSnapshot(snapshot: QueueSnapshot): QueueSnapshot {
	return Object.freeze({
		sessionId: snapshot.sessionId,
		revision: snapshot.revision,
		pendingSteers: Object.freeze(snapshot.pendingSteers.map(freezeRecord)),
		rejectedSteers: Object.freeze(snapshot.rejectedSteers.map(freezeRecord)),
		followUps: Object.freeze(snapshot.followUps.map(freezeRecord)),
	});
}

function freezeRecord(record: QueuedInput): QueuedInput {
	if (Object.isFrozen(record) && Object.isFrozen(record.imagePaths)) {
		return record;
	}
	return Object.freeze({
		...record,
		imagePaths: Object.freeze([...record.imagePaths]),
	});
}

function activeRecords(snapshot: QueueSnapshot): QueuedInput[] {
	return [
		...snapshot.pendingSteers,
		...snapshot.rejectedSteers,
		...snapshot.followUps,
	];
}

function nonEmpty(value: string, name: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new TypeError(`${name} must be a non-empty string`);
	}
	return value.trim();
}

function nextRevision(revision: number): number {
	if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) {
		throw new RangeError("queue revision cannot be incremented safely");
	}
	return revision + 1;
}

function utf8Length(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
