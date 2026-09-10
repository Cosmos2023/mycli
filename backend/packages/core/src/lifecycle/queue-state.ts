export type QueueItemKind = "pending_steer" | "rejected_steer" | "follow_up";
export type QueueDeliveryState = "queued" | "accepted" | "claimed" | "committed";
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
	readonly claimTurnId?: string;
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

export interface QueueRestorationClaim {
	readonly token: string;
	readonly snapshot: QueueSnapshot;
	readonly records: readonly QueuedInput[];
}

export interface QueueSteerResubmitResult {
	readonly snapshot: QueueSnapshot;
	readonly records: readonly QueuedInput[];
	readonly merged?: QueuedInput;
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
	const pending: QueuedInput[] = [];
	const rejected: QueuedInput[] = [];
	for (const storedRecord of snapshot.rejectedSteers) {
		const record = restoreClaimedRecord(storedRecord, input.committedQueueIds, now);
		if (!record) {
			changed = true;
			continue;
		}
		if (record !== storedRecord) changed = true;
		if (isPendingInternalNotification(record)) {
			pending.push(freezeRecord({
				...record,
				kind: "pending_steer",
				state: "accepted",
				updatedAt: now,
			}));
			changed = true;
			continue;
		}
		rejected.push(record);
	}
	for (const storedRecord of snapshot.pendingSteers) {
		const record = restoreClaimedRecord(storedRecord, input.committedQueueIds, now);
		if (!record) {
			changed = true;
			continue;
		}
		if (record !== storedRecord) changed = true;
		if (!isPendingInternalNotification(record)
			&& (activeTurnId === null || record.targetTurnId !== activeTurnId)) {
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
	const followUps: QueuedInput[] = [];
	for (const storedRecord of snapshot.followUps) {
		const record = restoreClaimedRecord(storedRecord, input.committedQueueIds, now);
		if (!record) {
			changed = true;
			continue;
		}
		if (record !== storedRecord) changed = true;
		if (isInternalNotification(record)) {
			pending.push(freezeRecord({
				...record,
				targetTurnId: "turn_pending",
				kind: "pending_steer",
				state: "accepted",
				updatedAt: now,
			}));
			changed = true;
			continue;
		}
		followUps.push(record);
	}
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

function restoreClaimedRecord(
	record: QueuedInput,
	committedQueueIds: ReadonlySet<string>,
	now: string,
): QueuedInput | undefined {
	if (committedQueueIds.has(record.queueId)) return undefined;
	if (record.state !== "claimed") return record;
	return freezeRecord({
		...withoutClaimTurnId(record),
		state: "queued",
		updatedAt: now,
	});
}

function isPendingInternalNotification(record: QueuedInput): boolean {
	return isInternalNotification(record) && record.targetTurnId === "turn_pending";
}

function isInternalNotification(record: QueuedInput): boolean {
	return record.source === "task_notification" || record.source === "agent_mailbox";
}

export function claimPendingSteers(
	snapshot: QueueSnapshot,
	turnId: string,
): readonly QueuedInput[] {
	validateSnapshot(snapshot, DEFAULT_QUEUE_CAPACITY);
	const normalizedTurnId = nonEmpty(turnId, "turnId");
	return Object.freeze(snapshot.pendingSteers.filter(
		(record) => record.state !== "claimed"
			&& (record.targetTurnId === normalizedTurnId || record.targetTurnId === "turn_pending"),
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
		(record) => record.state !== "claimed" && record.targetTurnId === normalizedTurnId,
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

export function preparePendingSteersForResubmit(
	snapshot: QueueSnapshot,
	turnId: string,
	now: string,
): QueueSteerResubmitResult {
	validateSnapshot(snapshot, DEFAULT_QUEUE_CAPACITY);
	const normalizedTurnId = nonEmpty(turnId, "turnId");
	const matching = snapshot.pendingSteers.filter(
		(record) => record.state !== "claimed"
			&& record.targetTurnId === normalizedTurnId
			&& !isInternalNotification(record),
	);
	if (matching.length === 0) {
		return Object.freeze({ snapshot, records: Object.freeze([]) });
	}

	const updatedAt = nonEmpty(now, "now");
	const mergedPayload = mergeQueuedInputPayloads(matching);
	const first = matching[0]!;
	const merged = freezeRecord({
		...first,
		targetTurnId: normalizedTurnId,
		kind: "rejected_steer",
		state: "queued",
		text: mergedPayload.text,
		imagePaths: mergedPayload.imagePaths,
		updatedAt,
	});
	const matchingIds = new Set(matching.map((record) => record.queueId));
	const candidate = freezeSnapshot({
		...snapshot,
		revision: nextRevision(snapshot.revision),
		pendingSteers: snapshot.pendingSteers.filter(
			(record) => !matchingIds.has(record.queueId),
		),
		rejectedSteers: [merged, ...snapshot.rejectedSteers],
	});
	validateSnapshot(candidate, DEFAULT_QUEUE_CAPACITY);
	return Object.freeze({
		snapshot: candidate,
		records: Object.freeze(matching),
		merged,
	});
}

export function nextQueuedInput(snapshot: QueueSnapshot): QueuedInput | undefined {
	validateSnapshot(snapshot, DEFAULT_QUEUE_CAPACITY);
	const next = snapshot.rejectedSteers.find((record) => !isInternalNotification(record))
		?? snapshot.followUps.find((record) => !isInternalNotification(record));
	return next?.state === "claimed" ? undefined : next;
}

export function claimQueuedInput(
	snapshot: QueueSnapshot,
	queueId: string,
	turnId: string,
	now: string,
): QueueSnapshot {
	validateSnapshot(snapshot, DEFAULT_QUEUE_CAPACITY);
	const expected = nextQueuedInput(snapshot);
	if (!expected || expected.queueId !== nonEmpty(queueId, "queueId")) {
		throw new QueueConflictError("queue id is not the next end-of-turn record");
	}
	return replaceQueueRecord(snapshot, freezeRecord({
		...expected,
		state: "claimed",
		claimTurnId: nonEmpty(turnId, "turnId"),
		updatedAt: nonEmpty(now, "now"),
	}));
}

export function releaseQueuedInputClaim(
	snapshot: QueueSnapshot,
	queueId: string,
	turnId: string,
	now: string,
): QueueSnapshot {
	validateSnapshot(snapshot, DEFAULT_QUEUE_CAPACITY);
	const record = claimedRecord(snapshot, queueId, turnId);
	return replaceQueueRecord(snapshot, freezeRecord({
		...withoutClaimTurnId(record),
		state: "queued",
		updatedAt: nonEmpty(now, "now"),
	}));
}

function withoutClaimTurnId(record: QueuedInput): QueuedInput {
	const queued = { ...record };
	delete queued.claimTurnId;
	return queued;
}

export function retireQueuedInputClaim(
	snapshot: QueueSnapshot,
	queueId: string,
	turnId: string,
): QueueSnapshot {
	validateSnapshot(snapshot, DEFAULT_QUEUE_CAPACITY);
	const record = claimedRecord(snapshot, queueId, turnId);
	return removeQueueRecord(snapshot, record);
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
			? snapshot.rejectedSteers.filter((record) => record.queueId !== expected.queueId)
			: snapshot.rejectedSteers,
		followUps: expected.kind === "follow_up"
			? snapshot.followUps.filter((record) => record.queueId !== expected.queueId)
			: snapshot.followUps,
	});
}

function claimedRecord(snapshot: QueueSnapshot, queueId: string, turnId: string): QueuedInput {
	const normalizedQueueId = nonEmpty(queueId, "queueId");
	const normalizedTurnId = nonEmpty(turnId, "turnId");
	const record = activeRecords(snapshot).find((item) => item.queueId === normalizedQueueId);
	if (record?.state !== "claimed" || record.claimTurnId !== normalizedTurnId) {
		throw new QueueConflictError("queued input claim does not match the reserved turn");
	}
	return record;
}

function replaceQueueRecord(snapshot: QueueSnapshot, replacement: QueuedInput): QueueSnapshot {
	return freezeSnapshot({
		...snapshot,
		revision: nextRevision(snapshot.revision),
		pendingSteers: snapshot.pendingSteers.map(
			(record) => record.queueId === replacement.queueId ? replacement : record,
		),
		rejectedSteers: snapshot.rejectedSteers.map(
			(record) => record.queueId === replacement.queueId ? replacement : record,
		),
		followUps: snapshot.followUps.map(
			(record) => record.queueId === replacement.queueId ? replacement : record,
		),
	});
}

function removeQueueRecord(snapshot: QueueSnapshot, record: QueuedInput): QueueSnapshot {
	return freezeSnapshot({
		...snapshot,
		revision: nextRevision(snapshot.revision),
		pendingSteers: snapshot.pendingSteers.filter((item) => item.queueId !== record.queueId),
		rejectedSteers: snapshot.rejectedSteers.filter((item) => item.queueId !== record.queueId),
		followUps: snapshot.followUps.filter((item) => item.queueId !== record.queueId),
	});
}

export function popLastFollowUp(snapshot: QueueSnapshot): QueueRemoval {
	validateSnapshot(snapshot, DEFAULT_QUEUE_CAPACITY);
	const index = snapshot.followUps.findLastIndex(
		(record) => record.state !== "claimed" && !isInternalNotification(record),
	);
	if (index < 0) {
		return Object.freeze({ snapshot });
	}
	const record = snapshot.followUps[index]!;
	return Object.freeze({
		record,
		snapshot: freezeSnapshot({
			...snapshot,
			revision: nextRevision(snapshot.revision),
			followUps: [
				...snapshot.followUps.slice(0, index),
				...snapshot.followUps.slice(index + 1),
			],
		}),
	});
}

export function clearQueue(snapshot: QueueSnapshot): QueueClearResult {
	validateSnapshot(snapshot, DEFAULT_QUEUE_CAPACITY);
	const records = Object.freeze(activeRecords(snapshot).filter(
		(record) => record.state !== "claimed" && !isInternalNotification(record),
	));
	if (records.length === 0) {
		return Object.freeze({ snapshot, records });
	}
	const removeIds = new Set(records.map((record) => record.queueId));
	return Object.freeze({
		records,
		snapshot: freezeSnapshot({
			...snapshot,
			revision: nextRevision(snapshot.revision),
			pendingSteers: snapshot.pendingSteers.filter(
				(record) => !removeIds.has(record.queueId),
			),
			rejectedSteers: snapshot.rejectedSteers.filter(
				(record) => !removeIds.has(record.queueId),
			),
			followUps: snapshot.followUps.filter(
				(record) => !removeIds.has(record.queueId),
			),
		}),
	});
}

export function claimQueueForRestoration(
	snapshot: QueueSnapshot,
	token: string,
	now: string,
): QueueRestorationClaim {
	validateSnapshot(snapshot, DEFAULT_QUEUE_CAPACITY);
	const normalizedToken = restorationToken(token);
	const existingClaims = activeRecords(snapshot).filter(isRestorationClaim);
	if (existingClaims.some((record) => record.claimTurnId !== normalizedToken)) {
		throw new QueueConflictError("another queue restoration is already in progress");
	}
	if (existingClaims.length > 0) {
		return Object.freeze({
			token: normalizedToken,
			snapshot,
			records: Object.freeze(existingClaims),
		});
	}
	const records = activeRecords(snapshot).filter(
		(record) => record.state !== "claimed" && !isInternalNotification(record),
	);
	if (records.length === 0) {
		return Object.freeze({ token: normalizedToken, snapshot, records: Object.freeze([]) });
	}
	const claimedIds = new Set(records.map((record) => record.queueId));
	const updatedAt = nonEmpty(now, "now");
	const claimRecord = (record: QueuedInput): QueuedInput => claimedIds.has(record.queueId)
		? freezeRecord({
			...record,
			state: "claimed",
			claimTurnId: normalizedToken,
			updatedAt,
		})
		: record;
	const candidate = freezeSnapshot({
		...snapshot,
		revision: nextRevision(snapshot.revision),
		pendingSteers: snapshot.pendingSteers.map(claimRecord),
		rejectedSteers: snapshot.rejectedSteers.map(claimRecord),
		followUps: snapshot.followUps.map(claimRecord),
	});
	validateSnapshot(candidate, DEFAULT_QUEUE_CAPACITY);
	return Object.freeze({
		token: normalizedToken,
		snapshot: candidate,
		records: Object.freeze(activeRecords(candidate).filter(
			(record) => claimedIds.has(record.queueId),
		)),
	});
}

export function retireQueueRestorationClaim(
	snapshot: QueueSnapshot,
	token: string,
): QueueSnapshot {
	validateSnapshot(snapshot, DEFAULT_QUEUE_CAPACITY);
	const normalizedToken = restorationToken(token);
	const restorationClaims = activeRecords(snapshot).filter(isRestorationClaim);
	if (restorationClaims.some((record) => record.claimTurnId !== normalizedToken)) {
		throw new QueueConflictError("queue restoration token is stale");
	}
	const removeIds = new Set(restorationClaims
		.filter((record) => record.claimTurnId === normalizedToken)
		.map((record) => record.queueId));
	if (removeIds.size === 0) return snapshot;
	return freezeSnapshot({
		...snapshot,
		revision: nextRevision(snapshot.revision),
		pendingSteers: snapshot.pendingSteers.filter((record) => !removeIds.has(record.queueId)),
		rejectedSteers: snapshot.rejectedSteers.filter((record) => !removeIds.has(record.queueId)),
		followUps: snapshot.followUps.filter((record) => !removeIds.has(record.queueId)),
	});
}

export function releaseQueueRestorationClaims(
	snapshot: QueueSnapshot,
	now: string,
): QueueSnapshot {
	validateSnapshot(snapshot, DEFAULT_QUEUE_CAPACITY);
	if (!activeRecords(snapshot).some(isRestorationClaim)) return snapshot;
	const updatedAt = nonEmpty(now, "now");
	const releaseRecord = (record: QueuedInput): QueuedInput => {
		if (!isRestorationClaim(record)) return record;
		return freezeRecord({
			...withoutClaimTurnId(record),
			state: record.kind === "pending_steer" ? "accepted" : "queued",
			updatedAt,
		});
	};
	return freezeSnapshot({
		...snapshot,
		revision: nextRevision(snapshot.revision),
		pendingSteers: snapshot.pendingSteers.map(releaseRecord),
		rejectedSteers: snapshot.rejectedSteers.map(releaseRecord),
		followUps: snapshot.followUps.map(releaseRecord),
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

function mergeQueuedInputPayloads(
	records: readonly QueuedInput[],
): { readonly text: string; readonly imagePaths: readonly string[] } {
	let imageOffset = 0;
	const imagePaths: string[] = [];
	const text = records.map((record) => {
		const rebased = record.text.replace(/\[image #(\d+)\]/giu, (placeholder, rawIndex: string) => {
			const index = Number.parseInt(rawIndex, 10);
			return Number.isSafeInteger(index) && index >= 1 && index <= record.imagePaths.length
				? `[image #${imageOffset + index}]`
				: placeholder;
		});
		imagePaths.push(...record.imagePaths);
		imageOffset += record.imagePaths.length;
		return rebased;
	}).join("\n\n");
	return Object.freeze({ text, imagePaths: Object.freeze(imagePaths) });
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
			if (record.state === "claimed") {
				if (!record.claimTurnId?.trim()
					|| (record.kind === "pending_steer" && !isRestorationClaim(record))) {
					throw new QueueConflictError("claimed queued input must own an end-of-turn reservation");
				}
			} else if (record.claimTurnId !== undefined) {
				throw new QueueConflictError("unclaimed queued input cannot retain a claim turn id");
			}
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

function isRestorationClaim(record: QueuedInput): boolean {
	return record.state === "claimed" && record.claimTurnId?.startsWith("restore_") === true;
}

function restorationToken(value: string): string {
	const token = nonEmpty(value, "token");
	if (!token.startsWith("restore_")) {
		throw new QueueConflictError("queue restoration token is invalid");
	}
	return token;
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
