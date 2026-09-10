import type { MycliShellLocalImageAttachment, MycliShellQueuedInputPreview } from "../model.ts";
import {
	isInternalTaskNotification,
	nextId,
	numberValue,
	recordValue,
	stringArrayValue,
	stringValue,
} from "./payload-values.ts";
import type {
	RuntimeLocalUserInput,
	RuntimeQueuedInputPreview,
	RuntimeSessionLocalInputs,
	RuntimeShellState,
} from "./runtime-state-model.ts";

export function runtimeStateWithLegacyQueueMigration(
	state: RuntimeShellState,
	payload: Record<string, unknown>,
): RuntimeShellState {
	const migration = recordValue(payload.legacy_user_queue_migration);
	if (!Array.isArray(migration.records) || migration.records.length === 0) return state;
	if (
		state.queuedPendingSteers.length > 0 ||
		state.queuedRejectedSteers.length > 0 ||
		state.queuedFollowUpInputs.length > 0
	) {
		return state;
	}
	const records = queuedInputPreviews(migration.records, []);
	return runtimeStateWithMessageQueues(state, {
		pendingSteers: records.filter((record) => record.kind === "pending_steer"),
		rejectedSteers: records.filter((record) => record.kind === "rejected_steer"),
		followUps: records.filter((record) => record.kind === "follow_up"),
	});
}

export function runtimeStateWithUserMessage(state: RuntimeShellState, message: string): RuntimeShellState {
	return {
		...state,
		transcript: [...state.transcript, { id: nextId("user"), type: "user", text: message, folded: false, metadata: {} }],
	};
}

export function runtimeStateWithPendingSteer(
	state: RuntimeShellState,
	input: RuntimeLocalUserInput,
): RuntimeShellState {
	return {
		...state,
		localPendingSteers: appendLocalInput(state.localPendingSteers, input),
	};
}

export function runtimeStateWithSubmittingMessage(
	state: RuntimeShellState,
	input: RuntimeLocalUserInput,
): RuntimeShellState {
	return {
		...state,
		localSubmittingMessages: appendLocalInput(state.localSubmittingMessages, input),
	};
}

export function runtimeInputDisposition(
	state: RuntimeShellState,
	backendTurnBusy: boolean,
): "submit" | "steer" | "follow_up" {
	if (state.liveStatus?.state === "interrupting") {
		return "follow_up";
	}
	if (state.turnRunning || state.activeTurnId) {
		return "steer";
	}
	return backendTurnBusy ? "follow_up" : "submit";
}

export function runtimeStateWithLocalFollowUp(
	state: RuntimeShellState,
	input: RuntimeLocalUserInput,
): RuntimeShellState {
	return {
		...state,
		localFollowUps: appendLocalInput(state.localFollowUps, input),
	};
}

export function runtimeStateRejectPendingSteer(
	state: RuntimeShellState,
	clientUserMessageId: string,
): RuntimeShellState {
	const input = state.localPendingSteers.find(
		(candidate) => candidate.clientUserMessageId === clientUserMessageId,
	);
	if (!input) return state;
	return {
		...state,
		localPendingSteers: state.localPendingSteers.filter(
			(candidate) => candidate.clientUserMessageId !== clientUserMessageId,
		),
		localRejectedSteers: appendLocalInput(state.localRejectedSteers, input),
	};
}

export function restorePendingSteersAfterInterrupt(state: RuntimeShellState): RuntimeShellState {
	return {
		...state,
		localRejectedSteers: state.localPendingSteers.reduce(
			(inputs, input) => appendLocalInput(inputs, input),
			state.localRejectedSteers,
		),
		localPendingSteers: [],
	};
}

export function resolveLocalInterruptInputs(
	state: RuntimeShellState,
	resubmitPendingSteers: boolean,
): {
	state: RuntimeShellState;
	restoreToComposer: RuntimeLocalUserInput[];
	dispatchNext: boolean;
} {
	if (resubmitPendingSteers) {
		return {
			state: {
				...state,
				localPendingSteers: [],
			},
			restoreToComposer: [],
			dispatchNext: false,
		};
	}

	const seen = new Set<string>();
	const restoreToComposer = [
		...state.localRejectedSteers,
		...state.localPendingSteers,
		...state.localFollowUps,
	].filter((input) => {
		if (seen.has(input.clientUserMessageId)) return false;
		seen.add(input.clientUserMessageId);
		return true;
	});
	return {
		state: {
			...state,
			localPendingSteers: [],
			localRejectedSteers: [],
			localFollowUps: [],
		},
		restoreToComposer,
		dispatchNext: false,
	};
}

export function popLastLocalFollowUp(
	state: RuntimeShellState,
): { state: RuntimeShellState; input: RuntimeLocalUserInput | null } {
	const input = state.localFollowUps.at(-1) ?? null;
	return {
		state: input ? { ...state, localFollowUps: state.localFollowUps.slice(0, -1) } : state,
		input,
	};
}

export function nextLocalUserInput(
	state: RuntimeShellState,
): { kind: "rejected" | "follow_up"; input: RuntimeLocalUserInput } | null {
	const rejected = state.localRejectedSteers[0];
	if (rejected) return { kind: "rejected", input: rejected };
	const followUp = state.localFollowUps[0];
	return followUp ? { kind: "follow_up", input: followUp } : null;
}

export function removeLocalUserInput(
	state: RuntimeShellState,
	clientUserMessageId: string,
): RuntimeShellState {
	const withoutIdentity = (inputs: RuntimeLocalUserInput[]) =>
		inputs.filter((input) => input.clientUserMessageId !== clientUserMessageId);
	return {
		...state,
		localPendingSteers: withoutIdentity(state.localPendingSteers),
		localRejectedSteers: withoutIdentity(state.localRejectedSteers),
		localFollowUps: withoutIdentity(state.localFollowUps),
		localSubmittingMessages: withoutIdentity(state.localSubmittingMessages),
	};
}

export function removeLocalUserInputForSession(
	state: RuntimeShellState,
	sessionId: string | null,
	clientUserMessageId: string,
): RuntimeShellState {
	if (!sessionId || !state.sessionId || sessionId === state.sessionId) {
		return removeLocalUserInput(state, clientUserMessageId);
	}
	const snapshot = state.sessionLocalInputs[sessionId];
	if (!snapshot) return state;
	const withoutIdentity = (inputs: RuntimeLocalUserInput[]) =>
		inputs.filter((input) => input.clientUserMessageId !== clientUserMessageId);
	return {
		...state,
		sessionLocalInputs: {
			...state.sessionLocalInputs,
			[sessionId]: {
				localPendingSteers: withoutIdentity(snapshot.localPendingSteers),
				localRejectedSteers: withoutIdentity(snapshot.localRejectedSteers),
				localFollowUps: withoutIdentity(snapshot.localFollowUps),
				localSubmittingMessages: withoutIdentity(snapshot.localSubmittingMessages),
			},
		},
	};
}

export function runtimeStateAcknowledgeQueuedInput(
	state: RuntimeShellState,
	clientUserMessageId: string,
	queuePayload: Record<string, unknown>,
	sessionId: string | null = state.sessionId,
): RuntimeShellState {
	if (sessionId && state.sessionId && sessionId !== state.sessionId) {
		return removeLocalUserInputForSession(state, sessionId, clientUserMessageId);
	}
	const acknowledged = applyQueuePayload(state, queuePayload, "event");
	// A delayed response may carry a snapshot older than a terminal queue event. In that case the
	// local recovery record belongs to the newer state and must not be removed by the stale ACK.
	return acknowledged === state
		? state
		: removeLocalUserInput(acknowledged, clientUserMessageId);
}

function appendLocalInput(
	inputs: RuntimeLocalUserInput[],
	input: RuntimeLocalUserInput,
): RuntimeLocalUserInput[] {
	const normalized = {
		...input,
		attachments: input.attachments.map((attachment) => ({ ...attachment })),
	};
	const existing = inputs.find(
		(candidate) => candidate.clientUserMessageId === normalized.clientUserMessageId,
	);
	if (!existing) return [...inputs, normalized];
	if (
		existing.message !== normalized.message ||
		JSON.stringify(existing.attachments) !== JSON.stringify(normalized.attachments)
	) {
		throw new Error(`conflicting local user message id: ${normalized.clientUserMessageId}`);
	}
	return inputs;
}

export function localInputsSnapshot(state: RuntimeShellState): RuntimeSessionLocalInputs {
	return cloneLocalInputsSnapshot({
		localPendingSteers: state.localPendingSteers,
		localRejectedSteers: state.localRejectedSteers,
		localFollowUps: state.localFollowUps,
		localSubmittingMessages: state.localSubmittingMessages,
	});
}

export function cloneLocalInputsSnapshot(
	snapshot?: RuntimeSessionLocalInputs,
): RuntimeSessionLocalInputs {
	const clone = (inputs: RuntimeLocalUserInput[] | undefined): RuntimeLocalUserInput[] =>
		(inputs ?? []).map((input) => ({
			...input,
			attachments: input.attachments.map((attachment) => ({ ...attachment })),
		}));
	return {
		localPendingSteers: clone(snapshot?.localPendingSteers),
		localRejectedSteers: clone(snapshot?.localRejectedSteers),
		localFollowUps: clone(snapshot?.localFollowUps),
		localSubmittingMessages: clone(snapshot?.localSubmittingMessages),
	};
}

function localImageAttachments(value: unknown): MycliShellLocalImageAttachment[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item, index) => {
		const record = recordValue(item);
		const path = stringValue(record.path);
		if (!path) return [];
		return [{
			path,
			placeholder: stringValue(record.placeholder) ?? `[image #${index + 1}]`,
		}];
	});
}

export function applyQueuePayload(
	state: RuntimeShellState,
	payload: Record<string, unknown>,
	legacyShape: "event" | "status",
): RuntimeShellState {
	const queueItems = recordValue(payload.queue_items);
	const hasStructuredItems =
		"pending_steers" in queueItems ||
		"rejected_steers" in queueItems ||
		"follow_ups" in queueItems;
	const revision = numberValue(payload.queue_revision);
	if (hasStructuredItems) {
		if (revision !== null && revision < state.queueRevision) {
			return state;
		}
		return runtimeStateWithMessageQueues(state, {
			pendingSteers: queuedInputPreviews(queueItems.pending_steers, []),
			rejectedSteers: queuedInputPreviews(queueItems.rejected_steers, []),
			followUps: queuedInputPreviews(queueItems.follow_ups, []),
			revision: revision ?? state.queueRevision,
			activity: payload.activity ?? payload.queue_activity,
		});
	}

	const itemPrefix = legacyShape === "status" ? "queued_" : "";
	return runtimeStateWithMessageQueues(state, {
		pendingSteers: queuedInputPreviews(
			payload[`${itemPrefix}steering_items`],
			payload[`${itemPrefix}steering`],
		),
		rejectedSteers: [],
		followUps: queuedInputPreviews(
			payload[`${itemPrefix}follow_up_items`],
			payload[`${itemPrefix}follow_up`],
		),
		activity: payload.activity ?? payload.queue_activity,
	});
}

function runtimeStateWithMessageQueues(
	state: RuntimeShellState,
	queues: {
		pendingSteers: RuntimeQueuedInputPreview[];
		rejectedSteers: RuntimeQueuedInputPreview[];
		followUps: RuntimeQueuedInputPreview[];
		revision?: number;
		activity?: unknown;
	},
): RuntimeShellState {
	const pendingSteers = visibleQueuedPreviews(queues.pendingSteers);
	const rejectedSteers = visibleQueuedPreviews(queues.rejectedSteers);
	const followUps = visibleQueuedPreviews(queues.followUps);
	const queueActivity = queueActivityFromPayload(
		queues.activity,
		pendingSteers,
		[...rejectedSteers, ...followUps],
	);
	return {
		...state,
		queueRevision: queues.revision ?? state.queueRevision,
		queuedPendingSteers: pendingSteers,
		queuedRejectedSteers: rejectedSteers,
		queuedFollowUpInputs: followUps,
		queuedInputs: [...pendingSteers, ...rejectedSteers, ...followUps].map((item) => item.message),
		hasPendingInput: pendingSteers.length > 0 || rejectedSteers.length > 0 || followUps.length > 0,
		queueActivity,
	};
}

export function projectedQueueInputs(state: RuntimeShellState): {
	pendingSteers: MycliShellQueuedInputPreview[];
	rejectedSteers: MycliShellQueuedInputPreview[];
	followUps: MycliShellQueuedInputPreview[];
} {
	const durableInputs = [
		...state.queuedPendingSteers,
		...state.queuedRejectedSteers,
		...state.queuedFollowUpInputs,
	];
	const durableClientIds = new Set(
		durableInputs.flatMap((input) => input.clientUserMessageId ? [input.clientUserMessageId] : []),
	);
	const seenLocalIds = new Set<string>();
	const localPreviews = (inputs: RuntimeLocalUserInput[]): MycliShellQueuedInputPreview[] => inputs
		.filter((input) => {
			if (durableClientIds.has(input.clientUserMessageId) || seenLocalIds.has(input.clientUserMessageId)) {
				return false;
			}
			seenLocalIds.add(input.clientUserMessageId);
			return true;
		})
		.map((input) => ({
			clientUserMessageId: input.clientUserMessageId,
			text: input.message,
			hasImages: input.attachments.length > 0,
			...(input.attachments.length > 0
				? { localImages: input.attachments.map((attachment) => ({ ...attachment })) }
				: {}),
		}));
	const durablePreviews = (
		inputs: RuntimeQueuedInputPreview[],
	): MycliShellQueuedInputPreview[] => inputs.map((input) => ({
		...(input.queueId ? { queueId: input.queueId } : {}),
		...(input.clientUserMessageId ? { clientUserMessageId: input.clientUserMessageId } : {}),
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		...(input.targetTurnId ? { targetTurnId: input.targetTurnId } : {}),
		...(input.claimTurnId ? { claimTurnId: input.claimTurnId } : {}),
		...(input.kind ? { kind: input.kind } : {}),
		...(input.state ? { state: input.state } : {}),
		text: input.message,
		hasImages: input.attachments.length > 0,
		...(input.attachments.length > 0
			? { localImages: input.attachments.map((attachment) => ({ ...attachment })) }
			: {}),
		...(input.source ? { source: input.source } : {}),
	}));

	// A rejected local record represents a newer disposition than a pending optimistic record.
	const localRejected = localPreviews(state.localRejectedSteers);
	const localPending = localPreviews(state.localPendingSteers);
	const localFollowUps = localPreviews(state.localFollowUps);
	return {
		pendingSteers: [...localPending, ...durablePreviews(state.queuedPendingSteers)],
		rejectedSteers: [...localRejected, ...durablePreviews(state.queuedRejectedSteers)],
		followUps: [...localFollowUps, ...durablePreviews(state.queuedFollowUpInputs)],
	};
}

function queueActivityFromPayload(
	_value: unknown,
	steering: RuntimeQueuedInputPreview[],
	followUp: RuntimeQueuedInputPreview[],
): { kind: string; steeringCount: number; followUpCount: number } {
	const fallbackSteeringCount = steering.length;
	const fallbackFollowUpCount = followUp.length;
	const fallbackKind = fallbackSteeringCount > 0 || fallbackFollowUpCount > 0 ? "pending_input" : "idle";
	return {
		kind: fallbackKind,
		steeringCount: fallbackSteeringCount,
		followUpCount: fallbackFollowUpCount,
	};
}

function visibleQueuedPreviews(items: RuntimeQueuedInputPreview[]): RuntimeQueuedInputPreview[] {
	return items.filter(
		(item) => item.source !== "task_notification"
			&& !item.claimTurnId?.startsWith("restore_")
			&& !isInternalTaskNotification(item.message),
	);
}

function queuedInputPreviews(items: unknown, fallback: unknown): RuntimeQueuedInputPreview[] {
	const raw = Array.isArray(items) && items.length > 0 ? items : stringArrayValue(fallback);
	return raw
		.map((item): RuntimeQueuedInputPreview | null => {
			if (typeof item === "string") {
				return item.trim() ? { message: item.trim(), attachments: [] } : null;
			}
			const record = recordValue(item);
			const message = stringValue(record.message) ?? stringValue(record.text);
			if (!message?.trim()) return null;
			const kindValue = stringValue(record.kind);
			const kind = kindValue === "pending_steer"
				|| kindValue === "rejected_steer"
				|| kindValue === "follow_up"
				? kindValue
				: undefined;
			return {
				...(stringValue(record.queue_id) ? { queueId: stringValue(record.queue_id)! } : {}),
				...(stringValue(record.client_user_message_id ?? record.client_turn_id)
					? { clientUserMessageId: stringValue(record.client_user_message_id ?? record.client_turn_id)! }
					: {}),
				...(stringValue(record.session_id) ? { sessionId: stringValue(record.session_id)! } : {}),
				...(stringValue(record.target_turn_id) ? { targetTurnId: stringValue(record.target_turn_id)! } : {}),
				...(stringValue(record.claim_turn_id) ? { claimTurnId: stringValue(record.claim_turn_id)! } : {}),
				...(kind ? { kind } : {}),
				...(stringValue(record.state) ? { state: stringValue(record.state)! } : {}),
				message: message.trim(),
				attachments: localImageAttachments(record.local_images),
				...(stringValue(record.source) ? { source: stringValue(record.source)! } : {}),
			};
		})
		.filter((item): item is RuntimeQueuedInputPreview => item !== null)
		.filter((item) => !isInternalTaskNotification(item.message));
}
