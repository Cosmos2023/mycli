import { StorageFailure } from "./session-store.ts";
import {
	projectTranscript,
	type TranscriptItem,
	type TranscriptProjectionOptions,
} from "./transcript-projector.ts";
import type { TranscriptEventEnvelope } from "./transcript-events.ts";

export function projectTranscriptEventsToReadableItems(
	events: readonly TranscriptEventEnvelope[],
	options: TranscriptProjectionOptions = {},
): readonly TranscriptItem[] {
	assertSequenceOrder(events);
	const history: Readonly<Record<string, unknown>>[] = [];
	const rollouts: Readonly<Record<string, unknown>>[] = [];
	for (const event of events) {
		const projected = readableRows(event);
		history.push(...projected.history);
		rollouts.push(...projected.rollouts);
	}
	return projectTranscript(history, rollouts, options);
}

function readableRows(event: TranscriptEventEnvelope): Readonly<{
	readonly history: readonly Readonly<Record<string, unknown>>[];
	readonly rollouts: readonly Readonly<Record<string, unknown>>[];
}> {
	const projection = "readableProjection" in event.payload
		? event.payload.readableProjection
		: undefined;
	if (projection?.hidden) return emptyRows();
	const readableCreatedAt = projection === undefined
		? event.createdAt
		: projection.createdAt;
	const base = {
		turn_id: event.turnId ?? null,
		metadata: readableCreatedAt ? { created_at: readableCreatedAt } : {},
	};
	switch (event.eventType) {
		case "user_input": {
			if (event.payload.source === "approval_resume") return emptyRows();
			return historyRows({
				...base,
				id: projection?.itemId ?? readableUserId(event),
				type: "user_message",
				text: event.payload.text,
				metadata: {
					...(readableCreatedAt ? { created_at: readableCreatedAt } : {}),
					source: event.payload.source,
					...(event.payload.queueId ? { queue_id: event.payload.queueId } : {}),
					...(event.payload.source === "queued" ? { queued: true } : {}),
				},
			});
		}
		case "assistant_output":
			return historyRows({
				...base,
				id: projection?.itemId
					?? (event.turnId ? `${event.turnId}:assistant:1` : event.eventId),
				type: "assistant_message",
				text: event.payload.text,
			});
		case "assistant_tool_call_batch": {
			const firstCallId = event.payload.calls[0]?.callId;
			const preamble = event.payload.text && projection?.assistantPreambleVisible !== false
				? [{
					...base,
					id: projection?.itemId ?? (event.turnId && firstCallId
						? `${event.turnId}:assistant-tool-preamble:${firstCallId}`
						: `${event.eventId}:assistant`),
					type: "assistant_message",
					text: event.payload.text,
				}]
				: [];
			const calls = event.payload.calls.map((call) => ({
				...base,
				id: projection?.toolCallItemIds?.[call.callId] ?? (event.turnId
					? `${event.turnId}:tool-call:${call.callId}`
					: `${event.eventId}:call:${call.callId}`),
				type: "tool_call",
				text: "",
				tool_name: call.name,
				call_id: call.callId,
				metadata: {
					...(readableCreatedAt ? { created_at: readableCreatedAt } : {}),
					arguments: toolArguments(call.argumentsJson),
					...(event.payload.responseId ? { response_id: event.payload.responseId } : {}),
				},
			}));
			return { history: Object.freeze([...preamble, ...calls]), rollouts: Object.freeze([]) };
		}
		case "tool_result":
			return historyRows({
				...base,
				id: projection?.itemId ?? (event.turnId
					? `${event.turnId}:tool-result:${event.payload.result.callId}`
					: event.eventId),
				type: "tool_result",
				text: event.payload.summary,
				tool_name: event.payload.result.toolName,
				call_id: event.payload.result.callId,
				metadata: {
					...(readableCreatedAt ? { created_at: readableCreatedAt } : {}),
					...event.payload.metadata,
					transcript_content: event.payload.result.output,
					success: event.payload.result.success,
					...(event.payload.errorKind ? { error_kind: event.payload.errorKind } : {}),
				},
			});
		case "context":
			return historyRows({
				...base,
				id: projection?.itemId ?? event.payload.itemId,
				type: "skill_instructions",
				text: event.payload.text,
				metadata: {
					...event.payload.metadata,
					...(readableCreatedAt ? { created_at: readableCreatedAt } : {}),
				},
			});
		case "display_activity":
			return historyRows(displayHistoryRow(event));
		case "turn_lifecycle":
			return event.payload.phase === "interrupted" && event.turnId
				? {
					history: Object.freeze([]),
					rollouts: Object.freeze([{
						turn_id: event.turnId,
						status: "interrupted",
						completed_at: event.createdAt,
						stop_reason: "interrupted",
						events: Object.freeze([]),
					}]),
				}
				: emptyRows();
		case "rollback":
			return historyRows({
				...base,
				id: event.eventId,
				type: "turn_rollback",
				text: "",
				metadata: { created_at: event.createdAt },
			});
		case "compaction":
			return historyRows({
				...base,
				id: event.eventId,
				type: "compaction_boundary",
				text: "",
				metadata: { created_at: event.createdAt },
			});
		case "opaque_legacy":
			return opaqueLegacyRows(event);
	}
}

function readableUserId(event: TranscriptEventEnvelope<"user_input">): string {
	if (!event.turnId) return event.eventId;
	return event.payload.queueId
		? `${event.turnId}:queue:${event.payload.queueId}`
		: `${event.turnId}:user:${event.payload.clientUserMessageId}`;
}

function displayHistoryRow(
	event: TranscriptEventEnvelope<"display_activity">,
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		id: event.eventId,
		turn_id: event.turnId ?? null,
		type: displayHistoryType(event.payload.activityType),
		text: event.payload.text ?? "",
		...(event.payload.toolName ? { tool_name: event.payload.toolName } : {}),
		...(event.payload.callId ? { call_id: event.payload.callId } : {}),
		metadata: {
			...event.payload.metadata,
			created_at: event.createdAt,
			...(event.payload.status ? { status: event.payload.status } : {}),
		},
	});
}

function displayHistoryType(activityType: string): string {
	switch (activityType) {
		case "reasoning": return "reasoning";
		case "plan": return "plan_update";
		case "turn_completed": return "turn_completed";
		case "approval_request": return "approval_request";
		case "approval_resolution": return "approval_resolution";
		case "clarification_request": return "clarification_request";
		case "clarification_response": return "clarification_response";
		case "shell": return "shell_session";
		case "error": return "error";
		case "warning": return "warning";
		case "file_change": return "file_change";
		case "tool_activation": return "tool_exposure";
		case "context_baseline": return "context_baseline_update";
		case "capability": return "capability";
		case "command_result": return "command_result";
		case "web_search": return "web_search";
		default: return "status";
	}
}

function opaqueLegacyRows(
	event: TranscriptEventEnvelope<"opaque_legacy">,
): Readonly<{
	readonly history: readonly Readonly<Record<string, unknown>>[];
	readonly rollouts: readonly Readonly<Record<string, unknown>>[];
}> {
	if (event.payload.sourceKind === "conversation_messages"
		|| event.payload.sourceKind === "session_summaries") return emptyRows();
	const payload = parseOpaqueRecord(event.payload.rawPayload, event.payload.errorCode);
	return event.payload.sourceKind === "history_items"
		? historyRows(payload)
		: { history: Object.freeze([]), rollouts: Object.freeze([payload]) };
}

function parseOpaqueRecord(
	rawPayload: string,
	errorCode: string,
): Readonly<Record<string, unknown>> {
	try {
		const value = JSON.parse(rawPayload) as unknown;
		if (!isRecord(value)) throw new Error("not an object");
		return value;
	} catch {
		throw new StorageFailure("opaque legacy readable event is not projectable", {
			legacy_error_code: errorCode,
		});
	}
}

function historyRows(
	...history: readonly Readonly<Record<string, unknown>>[]
): Readonly<{
	readonly history: readonly Readonly<Record<string, unknown>>[];
	readonly rollouts: readonly Readonly<Record<string, unknown>>[];
}> {
	return { history: Object.freeze(history), rollouts: Object.freeze([]) };
}

function emptyRows(): Readonly<{
	readonly history: readonly Readonly<Record<string, unknown>>[];
	readonly rollouts: readonly Readonly<Record<string, unknown>>[];
}> {
	return { history: Object.freeze([]), rollouts: Object.freeze([]) };
}

function toolArguments(value: string): Readonly<Record<string, unknown>> {
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function assertSequenceOrder(events: readonly TranscriptEventEnvelope[]): void {
	let previous = 0;
	for (const event of events) {
		if (event.sequenceNo <= previous) {
			throw new StorageFailure("transcript events are not in sequence order");
		}
		previous = event.sequenceNo;
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
