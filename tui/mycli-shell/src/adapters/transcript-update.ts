import type { RuntimeShellState } from "./runtime-state.ts";

export type TranscriptUpdateKind = "unchanged" | "tail" | "replace";

/** Classifies immutable runtime transcript updates for the TUI reconciliation path. */
export function classifyRuntimeTranscriptUpdate(
	previous: RuntimeShellState,
	next: RuntimeShellState,
): TranscriptUpdateKind {
	if (
		previous.workspace !== next.workspace ||
		previous.turnRunning !== next.turnRunning ||
		previous.settings.toolDetailsDefault !== next.settings.toolDetailsDefault
	) {
		return "replace";
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
