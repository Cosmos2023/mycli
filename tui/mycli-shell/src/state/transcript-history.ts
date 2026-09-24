import { booleanValue, recordValue, stringValue, textValue } from "./payload-values.ts";
import { mergeProviderAttemptHistory } from "./provider-attempts.ts";
import type { RuntimeShellState, RuntimeTranscriptItem } from "./runtime-state-model.ts";
import { eventBelongsToActiveSession } from "./session-ownership.ts";
import { planUpdateFromPayload, taskProgressFromPlanUpdate } from "./transcript-plans.ts";
import { isTranscriptItem, toolRecordFromTranscriptItem } from "./transcript-records.ts";
import { isShellOutputLifecycle, mergeShellOutputIntoExecution } from "./transcript-shell.ts";

export function runtimeStateFromTranscript(state: RuntimeShellState, payload: Record<string, unknown>): RuntimeShellState {
	return runtimeStateFromTranscriptPage(state, payload, "merge");
}

export function runtimeStateFromOlderTranscriptPage(
	state: RuntimeShellState,
	payload: Record<string, unknown>,
): RuntimeShellState {
	return runtimeStateFromTranscriptPage(state, payload, "prepend");
}

function runtimeStateFromTranscriptPage(
	state: RuntimeShellState,
	payload: Record<string, unknown>,
	mode: "merge" | "prepend",
): RuntimeShellState {
	if (!eventBelongsToActiveSession(state, payload)) return state;
	const rawItems = Array.isArray(payload.items)
		? payload.items
				.filter(isTranscriptItem)
				.map((item) => ({ ...item, metadata: recordValue(item.metadata) }))
		: [];
	const items = rawItems.flatMap((item) => {
		if (item.type === "command_result") return [];
		if (item.type !== "plan_update") return [item];
		const normalized = planUpdateFromPayload(recordValue(item.metadata), item.id, item.text);
		return normalized ? [{ ...item, ...normalized }] : [];
	});
	const resumedItems = items.map((item) =>
		isToolTranscriptItem(item)
			? { ...item, folded: true }
			: item,
	);
	const transcript = coalesceResumedShellOutputItems(
		coalesceResumedTerminalWaits(
			coalesceLegacyToolItems(mergeTranscriptItemsById(
				mode === "prepend" ? resumedItems : state.transcript,
				mode === "prepend" ? state.transcript : resumedItems,
			)),
		),
	);
	const latestPlanUpdate = [...transcript].reverse().find((item) => item.type === "plan_update");
	return mergeProviderAttemptHistory({
		...state,
		transcript,
		transcriptNextBefore: typeof payload.next_before === "string"
			? payload.next_before
			: null,
		providerAttemptsNextBefore: "provider_attempts_next_before" in payload
			? stringValue(payload.provider_attempts_next_before)
			: payload.provider_attempts_truncated === true && Array.isArray(payload.provider_attempts)
				? stringValue(recordValue(payload.provider_attempts[0]).eventId)
				: payload.provider_attempts_truncated === false ? null : state.providerAttemptsNextBefore,
		taskProgress: latestPlanUpdate ? taskProgressFromPlanUpdate(latestPlanUpdate) : state.taskProgress,
	}, Array.isArray(payload.provider_attempts) ? payload.provider_attempts : []);
}

function mergeTranscriptItemsById(
	existing: RuntimeTranscriptItem[],
	incoming: RuntimeTranscriptItem[],
): RuntimeTranscriptItem[] {
	const merged: RuntimeTranscriptItem[] = [];
	const indexes = new Map<string, number>();
	for (const item of [...existing, ...incoming]) {
		const index = indexes.get(item.id);
		if (index === undefined) {
			indexes.set(item.id, merged.length);
			merged.push(item);
		} else {
			merged[index] = item;
		}
	}
	return merged;
}

function coalesceResumedShellOutputItems(items: RuntimeTranscriptItem[]): RuntimeTranscriptItem[] {
	let coalesced: RuntimeTranscriptItem[] = [];
	for (const item of items) {
		const metadata = recordValue(item.metadata);
		const display = recordValue(metadata.display);
		const failed =
			booleanValue(metadata.success) === false ||
			["error", "failed", "cancelled"].includes(stringValue(display.status) ?? stringValue(metadata.status) ?? "");
		if (isShellOutputLifecycle(metadata) && !toolRecordFromTranscriptItem(item).terminal_interaction && !failed) {
			const merged = mergeShellOutputIntoExecution(coalesced, metadata);
			if (merged !== null) {
				coalesced = merged;
			}
			continue;
		}
		coalesced.push(item);
	}
	return coalesced;
}

/**
 * Resumed transcripts keep one wait row per run of polls instead of one row per poll, mirroring
 * the waiter the live reducer records when a background-terminal wait ends.
 */
function coalesceResumedTerminalWaits(items: RuntimeTranscriptItem[]): RuntimeTranscriptItem[] {
	const coalesced: RuntimeTranscriptItem[] = [];
	const trailingWaits = new Map<string, number>();
	for (const item of items) {
		if (item.type === "user" || item.type === "turn_completed") trailingWaits.clear();
		if (!isToolTranscriptItem(item)) {
			coalesced.push(item);
			continue;
		}
		const record = toolRecordFromTranscriptItem(item);
		const interaction = record.terminal_interaction;
		if (interaction?.kind !== "poll") {
			if (interaction?.kind === "input") trailingWaits.delete(interaction.shell_id);
			const finishedShellId = record.shell?.terminal_state ? record.shell.shell_id : undefined;
			if (finishedShellId) trailingWaits.delete(finishedShellId);
			coalesced.push(item);
			continue;
		}
		const existing = trailingWaits.get(interaction.shell_id);
		if (existing === undefined) {
			trailingWaits.set(interaction.shell_id, coalesced.push(item) - 1);
			continue;
		}
		// Keep the newest poll of the run so the collapsed row carries the freshest interaction.
		coalesced[existing] = item;
	}
	return coalesced;
}

function coalesceLegacyToolItems(items: RuntimeTranscriptItem[]): RuntimeTranscriptItem[] {
	const coalesced: RuntimeTranscriptItem[] = [];
	const pendingByCallId = new Map<string, number>();

	for (const item of items) {
		const callId = toolItemCallId(item);
		const existingIndex = callId ? pendingByCallId.get(callId) : undefined;
		const existing = existingIndex === undefined ? undefined : coalesced[existingIndex];
		if (existing && isToolSummaryDetailPair(existing, item)) {
			coalesced[existingIndex!] = mergeToolSummaryDetail(existing, item);
			pendingByCallId.delete(callId!);
			continue;
		}

		const index = coalesced.push(item) - 1;
		if (callId && isToolTranscriptItem(item)) {
			pendingByCallId.set(callId, index);
		}
	}

	return coalesced;
}

function toolItemCallId(item: RuntimeTranscriptItem): string | null {
	if (!isToolTranscriptItem(item)) return null;
	if (item.tool_record) return item.tool_record.call_id ?? null;
	const metadata = recordValue(item.metadata);
	return stringValue(metadata.call_id) ?? stringValue(metadata.callId);
}

function isToolTranscriptItem(item: RuntimeTranscriptItem): boolean {
	return item.type === "tool_summary" || item.type === "tool_detail";
}

function isToolSummaryDetailPair(first: RuntimeTranscriptItem, second: RuntimeTranscriptItem): boolean {
	return (first.type === "tool_summary" && second.type === "tool_detail")
		|| (first.type === "tool_detail" && second.type === "tool_summary");
}

function mergeToolSummaryDetail(first: RuntimeTranscriptItem, second: RuntimeTranscriptItem): RuntimeTranscriptItem {
	const summary = first.type === "tool_summary" ? first : second;
	const detail = first.type === "tool_detail" ? first : second;
	const summaryMetadata = recordValue(summary.metadata);
	const detailMetadata = recordValue(detail.metadata);
	const outputPreview = textValue(detailMetadata.output_preview) ?? textValue(detail.text);
	return {
		...summary,
		tool_record: summary.tool_record && detail.tool_record
			? { ...summary.tool_record, ...detail.tool_record,
				...(detail.tool_record.shell ? { shell: { ...summary.tool_record.shell, ...detail.tool_record.shell } } : {}) }
			: detail.tool_record ?? summary.tool_record,
		metadata: {
			...summaryMetadata,
			...detailMetadata,
			status: stringValue(detailMetadata.status) ?? "done",
			...(outputPreview ? { output_preview: outputPreview } : {}),
		},
	};
}
