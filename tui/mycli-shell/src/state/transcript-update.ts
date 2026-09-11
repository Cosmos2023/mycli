import type { RuntimeShellState } from "./runtime-state-model.ts";

import type { TranscriptUpdateKind } from "../model.ts";

/** Classifies immutable runtime transcript updates for the TUI reconciliation path. */
export function classifyRuntimeTranscriptUpdate(
	previous: RuntimeShellState,
	next: RuntimeShellState,
	eventType?: string,
): TranscriptUpdateKind {
	if (projectionContextChanged(previous, next)) {
		return "replace";
	}
	if (eventType === "message.delta" && isActiveAssistantTailDelta(previous, next)) {
		return "tail";
	}

	const transcriptUpdate = classifyTranscriptArrays(previous.transcript, next.transcript);
	const reasoningChanged =
		previous.activeAssistantItemId !== next.activeAssistantItemId ||
		previous.liveReasoning?.text !== next.liveReasoning?.text ||
		previous.liveReasoning?.kind !== next.liveReasoning?.kind;
	if (transcriptUpdate === "unchanged" && reasoningChanged) {
		return activeAssistantIsAtTail(next) ? "tail" : "replace";
	}
	return transcriptUpdate;
}

function projectionContextChanged(
	previous: RuntimeShellState,
	next: RuntimeShellState,
): boolean {
	return previous.workspace !== next.workspace ||
		previous.turnRunning !== next.turnRunning ||
		previous.settings.toolDetailsDefault !== next.settings.toolDetailsDefault;
}

function isActiveAssistantTailDelta(
	previous: RuntimeShellState,
	next: RuntimeShellState,
): boolean {
	const activeId = next.activeAssistantItemId;
	const nextTail = next.transcript.at(-1);
	if (!activeId || nextTail?.id !== activeId) return false;
	if (next.transcript.length === previous.transcript.length + 1) {
		return true;
	}
	if (next.transcript.length !== previous.transcript.length) return false;
	return previous.activeAssistantItemId === activeId &&
		previous.transcript.at(-1)?.id === activeId;
}

function activeAssistantIsAtTail(state: RuntimeShellState): boolean {
	const activeId = state.activeAssistantItemId;
	if (!activeId) return false;
	for (let index = state.transcript.length - 1; index >= 0; index -= 1) {
		const item = state.transcript[index]!;
		if (item.id === activeId) return true;
		if (item.type !== "reasoning") return false;
	}
	return false;
}

function classifyTranscriptArrays(
	previous: RuntimeShellState["transcript"],
	next: RuntimeShellState["transcript"],
): TranscriptUpdateKind {
	if (previous === next) return "unchanged";

	const sharedLength = Math.min(previous.length, next.length);
	let prefixLength = 0;
	while (prefixLength < sharedLength && previous[prefixLength] === next[prefixLength]) {
		prefixLength += 1;
	}
	if (prefixLength === previous.length && prefixLength === next.length) return "unchanged";
	if (prefixLength === sharedLength) return "tail";
	if (previous.length === next.length && prefixLength === previous.length - 1) return "tail";
	return "replace";
}
