import type { ProviderRequestManifest } from "@mycli/core";
import { projectTranscriptEventsToReadableItems } from "../projections/transcript-readable-projector.ts";
import { TRANSCRIPT_TEXT_MAX_CHARS, type TranscriptItem } from "../projections/transcript-projector.ts";
import type { SessionOverview } from "../sessions/session-store.ts";
import type { TranscriptEventEnvelope } from "./transcript-events.ts";

export const SNAPSHOT_EVENT_LIMIT = 2_000;
export const SNAPSHOT_ITEM_LIMIT = 500;

export interface TranscriptSnapshotCoverage {
	readonly source: "sqlite";
	readonly mode: "recent_readable_history";
	readonly event_limit: number;
	readonly item_limit: number;
	readonly text_limit_chars: number;
	readonly included_events: number;
	readonly included_items: number;
	readonly omitted_items_in_window: number;
	readonly has_older_events: boolean;
	readonly history_truncated: boolean;
	readonly truncated_items: number;
	readonly first_event_sequence: number | null;
	readonly last_event_sequence: number | null;
}

export interface TranscriptSnapshotWindow {
	readonly items: readonly TranscriptItem[];
	readonly coverage: TranscriptSnapshotCoverage;
}

export interface TranscriptSnapshotSessionMetadata {
	readonly thread_id: string;
	readonly status: string;
	readonly summary_count: number;
	readonly title?: string;
	readonly parent_session_id?: string;
	readonly fork_point?: number;
	readonly latest_turn_status?: string;
}

export interface TranscriptSnapshotRequestSummary {
	readonly request_id: string;
	readonly turn_id: string;
	readonly provider_step: number;
	readonly created_at: string;
	readonly provider: string;
	readonly protocol: string;
	readonly model: string;
	readonly reasoning_effort?: string;
	readonly instruction_snapshot_id: string;
	readonly tool_set_snapshot_id: string;
	readonly model_input_event_count?: number;
}

export function projectTranscriptSnapshotWindow(
	events: readonly TranscriptEventEnvelope[],
	hasOlderEvents: boolean,
): TranscriptSnapshotWindow {
	const projected = projectTranscriptEventsToReadableItems(events, { limit: Number.MAX_SAFE_INTEGER });
	const items = Object.freeze(projected.slice(-SNAPSHOT_ITEM_LIMIT));
	const omittedItems = projected.length - items.length;
	return Object.freeze({
		items,
		coverage: Object.freeze({
			source: "sqlite",
			mode: "recent_readable_history",
			event_limit: SNAPSHOT_EVENT_LIMIT,
			item_limit: SNAPSHOT_ITEM_LIMIT,
			text_limit_chars: TRANSCRIPT_TEXT_MAX_CHARS,
			included_events: events.length,
			included_items: items.length,
			omitted_items_in_window: omittedItems,
			has_older_events: hasOlderEvents,
			history_truncated: hasOlderEvents || omittedItems > 0,
			truncated_items: items.filter((item) => item.truncated).length,
			first_event_sequence: events[0]?.sequenceNo ?? null,
			last_event_sequence: events.at(-1)?.sequenceNo ?? null,
		}),
	});
}

export function snapshotSessionMetadata(overview: SessionOverview): TranscriptSnapshotSessionMetadata {
	return Object.freeze({
		thread_id: overview.threadId,
		status: overview.status,
		summary_count: overview.summaryCount,
		...(overview.title === undefined ? {} : { title: overview.title }),
		...(overview.parentId === undefined ? {} : { parent_session_id: overview.parentId }),
		...(overview.forkPoint === undefined ? {} : { fork_point: overview.forkPoint }),
		...(overview.latestTurnStatus === undefined ? {} : { latest_turn_status: overview.latestTurnStatus }),
	});
}

export function snapshotRequestSummary(manifest: ProviderRequestManifest): TranscriptSnapshotRequestSummary {
	return Object.freeze({
		request_id: manifest.requestId,
		turn_id: manifest.turnId,
		provider_step: manifest.providerStep,
		created_at: manifest.createdAt,
		provider: manifest.providerConfig.provider,
		protocol: manifest.providerConfig.protocol,
		model: manifest.providerConfig.model,
		...(manifest.providerConfig.reasoningEffort === undefined
			? {} : { reasoning_effort: manifest.providerConfig.reasoningEffort }),
		instruction_snapshot_id: manifest.instructionSnapshotId,
		tool_set_snapshot_id: manifest.toolSetSnapshotId,
		...(manifest.schemaVersion === 3
			? { model_input_event_count: manifest.timelineEventCount }
			: manifest.schemaVersion === 2 ? { model_input_event_count: manifest.timelineEventIds.length } : {}),
	});
}

export function parseSnapshotCoverage(
	value: unknown,
	items: readonly TranscriptItem[],
): TranscriptSnapshotCoverage | undefined {
	if (!isRecord(value)
		|| value.source !== "sqlite" || value.mode !== "recent_readable_history"
		|| !positiveInteger(value.event_limit) || !positiveInteger(value.item_limit)
		|| !positiveInteger(value.text_limit_chars)
		|| !nonnegativeInteger(value.included_events) || value.included_events > value.event_limit
		|| value.included_items !== items.length || items.length > value.item_limit
		|| !nonnegativeInteger(value.omitted_items_in_window)
		|| typeof value.has_older_events !== "boolean"
		|| value.history_truncated !== (value.has_older_events || value.omitted_items_in_window > 0)
		|| value.truncated_items !== items.filter((item) => item.truncated).length
		|| !sequence(value.first_event_sequence) || !sequence(value.last_event_sequence)) return undefined;
	if (value.included_events === 0) {
		if (value.first_event_sequence !== null || value.last_event_sequence !== null || items.length > 0) return undefined;
	} else if (value.first_event_sequence === null || value.last_event_sequence === null
		|| value.first_event_sequence > value.last_event_sequence) return undefined;
	return Object.freeze({
		source: "sqlite", mode: "recent_readable_history",
		event_limit: value.event_limit, item_limit: value.item_limit, text_limit_chars: value.text_limit_chars,
		included_events: value.included_events, included_items: items.length,
		omitted_items_in_window: value.omitted_items_in_window,
		has_older_events: value.has_older_events, history_truncated: value.history_truncated,
		truncated_items: value.truncated_items,
		first_event_sequence: value.first_event_sequence, last_event_sequence: value.last_event_sequence,
	});
}

export function parseSnapshotSessionMetadata(value: unknown): TranscriptSnapshotSessionMetadata | undefined {
	if (!isRecord(value) || !boundedText(value.thread_id, 512) || !boundedText(value.status, 64)
		|| !nonnegativeInteger(value.summary_count)
		|| !optionalText(value.title, 1_024) || !optionalText(value.parent_session_id, 512)
		|| !optionalText(value.latest_turn_status, 64)
		|| (value.fork_point !== undefined && !nonnegativeInteger(value.fork_point))) return undefined;
	return Object.freeze({
		thread_id: value.thread_id, status: value.status, summary_count: value.summary_count,
		...(value.title === undefined ? {} : { title: value.title }),
		...(value.parent_session_id === undefined ? {} : { parent_session_id: value.parent_session_id }),
		...(value.fork_point === undefined ? {} : { fork_point: value.fork_point }),
		...(value.latest_turn_status === undefined ? {} : { latest_turn_status: value.latest_turn_status }),
	});
}

export function parseSnapshotRequestSummary(value: unknown): TranscriptSnapshotRequestSummary | undefined {
	if (!isRecord(value) || !boundedText(value.request_id, 512) || !boundedText(value.turn_id, 512)
		|| !nonnegativeInteger(value.provider_step) || !boundedText(value.created_at, 100)
		|| !boundedText(value.provider, 128) || !boundedText(value.protocol, 128) || !boundedText(value.model, 512)
		|| !optionalText(value.reasoning_effort, 64)
		|| !boundedText(value.instruction_snapshot_id, 512) || !boundedText(value.tool_set_snapshot_id, 512)
		|| (value.model_input_event_count !== undefined && !nonnegativeInteger(value.model_input_event_count))) return undefined;
	return Object.freeze({
		request_id: value.request_id, turn_id: value.turn_id, provider_step: value.provider_step,
		created_at: value.created_at, provider: value.provider, protocol: value.protocol, model: value.model,
		...(value.reasoning_effort === undefined ? {} : { reasoning_effort: value.reasoning_effort }),
		instruction_snapshot_id: value.instruction_snapshot_id, tool_set_snapshot_id: value.tool_set_snapshot_id,
		...(value.model_input_event_count === undefined ? {} : { model_input_event_count: value.model_input_event_count }),
	});
}

function boundedText(value: unknown, limit: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= limit && !value.includes("\0");
}

function optionalText(value: unknown, limit: number): value is string | undefined {
	return value === undefined || boundedText(value, limit);
}

function nonnegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
	return nonnegativeInteger(value) && value > 0;
}

function sequence(value: unknown): value is number | null {
	return value === null || positiveInteger(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
