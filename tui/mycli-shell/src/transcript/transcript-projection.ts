import type { MycliShellTranscriptBlock } from "../model.ts";
import type {
	CollapsedToolGroup,
	CollapsedToolGroupItem,
} from "./tool-group.ts";
import { shellContextActivity, toolContextActivity } from "./context-activity.ts";

type MainTranscriptBlock = Exclude<MycliShellTranscriptBlock, { kind: "subagent" }>;

export type ProjectedTranscriptBlock =
	| MainTranscriptBlock
	| { id: string; kind: "tool_group"; group: CollapsedToolGroup }
	| { id: string; kind: "assistant_separator" };

type TranscriptProjectionSourceSpan = {
	start: number;
	end: number;
	contextRunStart?: number;
	// Preserve the incoming state so a tail update never scans earlier turns.
	hadWorkActivity: boolean;
};

type TranscriptSourceIdentity = Pick<MycliShellTranscriptBlock, "id" | "kind">;

export type TranscriptProjectionState = {
	blocks: ProjectedTranscriptBlock[];
	sourceSpans: TranscriptProjectionSourceSpan[];
	sourceLength: number;
	hadWorkActivity: boolean;
	penultimateSourceIdentity?: TranscriptSourceIdentity;
	lastSourceIdentity?: TranscriptSourceIdentity;
};

export type TranscriptProjectionUpdate = {
	projection: TranscriptProjectionState;
	stablePrefixLength: number;
	replacedBlocks: ProjectedTranscriptBlock[];
};

export function projectTranscriptBlocks(blocks: MycliShellTranscriptBlock[]): ProjectedTranscriptBlock[] {
	return createTranscriptProjection(blocks).blocks;
}

export function createTranscriptProjection(blocks: MycliShellTranscriptBlock[]): TranscriptProjectionState {
	const range = projectTranscriptRange(blocks, 0);
	return projectionState(blocks, range.blocks, range.sourceSpans, range.hadWorkActivity);
}

/** Reprojects only the grouping-sensitive suffix after a validated tail update hint. */
export function projectTranscriptTail(
	blocks: MycliShellTranscriptBlock[],
	previous: TranscriptProjectionState,
): TranscriptProjectionUpdate {
	if (!canProjectTail(blocks, previous)) {
		return {
			projection: createTranscriptProjection(blocks),
			stablePrefixLength: 0,
			replacedBlocks: previous.blocks,
		};
	}

	const sourceStart = tailProjectionSourceStart(previous, blocks.length > previous.sourceLength);
	const stablePrefixLength = projectedPrefixLength(previous.sourceSpans, sourceStart);
	const hadWorkActivity = previous.sourceSpans[stablePrefixLength]?.hadWorkActivity ?? previous.hadWorkActivity;
	const suffix = projectTranscriptRange(blocks, sourceStart, hadWorkActivity);
	const replacedBlocks = previous.blocks.splice(
		stablePrefixLength,
		previous.blocks.length - stablePrefixLength,
		...suffix.blocks,
	);
	previous.sourceSpans.splice(
		stablePrefixLength,
		previous.sourceSpans.length - stablePrefixLength,
		...suffix.sourceSpans,
	);
	previous.hadWorkActivity = suffix.hadWorkActivity;
	return {
		projection: updateProjectionSourceState(previous, blocks),
		stablePrefixLength,
		replacedBlocks,
	};
}

function projectTranscriptRange(
	blocks: MycliShellTranscriptBlock[],
	start: number,
	hadWorkActivity = false,
): Pick<TranscriptProjectionState, "blocks" | "sourceSpans" | "hadWorkActivity"> {
	const projected: ProjectedTranscriptBlock[] = [];
	const sourceSpans: TranscriptProjectionSourceSpan[] = [];
	let pending: Array<{ block: MainTranscriptBlock; sourceIndex: number; hadWorkActivity: boolean }> = [];

	const flushPending = (): void => {
		const contextRunStart = pending[0]?.sourceIndex;
		if (pending.length > 0 && !pending.some(({ block }) => isExpandedContextBlock(block))) {
			projected.push(createGroup(pending.map(({ block }) => block)));
			sourceSpans.push({
				start: contextRunStart ?? start,
				end: (pending.at(-1)?.sourceIndex ?? start) + 1,
				contextRunStart,
				hadWorkActivity: pending[0]!.hadWorkActivity,
			});
		} else {
			for (const { block, sourceIndex, hadWorkActivity: precedingWork } of pending) {
				projected.push(block);
				sourceSpans.push({ start: sourceIndex, end: sourceIndex + 1, contextRunStart, hadWorkActivity: precedingWork });
			}
		}
		pending = [];
	};

	for (let sourceIndex = start; sourceIndex < blocks.length; sourceIndex += 1) {
		const block = blocks[sourceIndex]!;
		if (block.kind === "subagent") {
			flushPending();
			continue;
		}
		const span = { start: sourceIndex, end: sourceIndex + 1, hadWorkActivity };
		if (block.kind === "turn_completed" || (block.kind === "message" && block.message.role === "user")) {
			hadWorkActivity = false;
		} else if (isWorkActivity(block)) {
			hadWorkActivity = true;
		}
		if (isContextBlock(block)) {
			pending.push({ block, sourceIndex, hadWorkActivity: span.hadWorkActivity });
			continue;
		}
		flushPending();
		if (hadWorkActivity && block.kind === "message" && block.message.role === "assistant" && block.message.text.trim()) {
			projected.push({ id: `assistant_separator:${block.id}`, kind: "assistant_separator" });
			sourceSpans.push(span);
		}
		projected.push(block);
		sourceSpans.push(span);
	}
	flushPending();
	return { blocks: projected, sourceSpans, hadWorkActivity };
}

function projectionState(
	source: MycliShellTranscriptBlock[],
	blocks: ProjectedTranscriptBlock[],
	sourceSpans: TranscriptProjectionSourceSpan[],
	hadWorkActivity: boolean,
): TranscriptProjectionState {
	return updateProjectionSourceState({
		blocks,
		sourceSpans,
		sourceLength: 0,
		hadWorkActivity,
	}, source);
}

function updateProjectionSourceState(
	state: TranscriptProjectionState,
	source: MycliShellTranscriptBlock[],
): TranscriptProjectionState {
	state.sourceLength = source.length;
	state.penultimateSourceIdentity = source.length >= 2
		? sourceIdentity(source[source.length - 2]!)
		: undefined;
	state.lastSourceIdentity = source.length > 0
		? sourceIdentity(source[source.length - 1]!)
		: undefined;
	return state;
}

function canProjectTail(
	blocks: MycliShellTranscriptBlock[],
	previous: TranscriptProjectionState,
): boolean {
	if (previous.sourceLength === 0) return blocks.length > 0;
	if (blocks.length < previous.sourceLength) return false;
	if (blocks.length > previous.sourceLength) {
		return sameSourceIdentity(blocks[previous.sourceLength - 1], previous.lastSourceIdentity);
	}
	if (blocks.length === 1) return true;
	return sameSourceIdentity(blocks[blocks.length - 2], previous.penultimateSourceIdentity);
}

function sourceIdentity(block: MycliShellTranscriptBlock): TranscriptSourceIdentity {
	return { id: block.id, kind: block.kind };
}

function sameSourceIdentity(
	block: MycliShellTranscriptBlock | undefined,
	identity: TranscriptSourceIdentity | undefined,
): boolean {
	return block?.id === identity?.id && block?.kind === identity?.kind;
}

function tailProjectionSourceStart(previous: TranscriptProjectionState, appending: boolean): number {
	const { sourceLength, sourceSpans, blocks } = previous;
	if (sourceLength === 0) return 0;
	const lastSpanIndex = sourceSpans.length - 1;
	const lastSpan = sourceSpans[lastSpanIndex];
	const lastBlock = blocks[lastSpanIndex];
	if (lastSpan?.end === sourceLength && lastBlock && isProjectedContextBlock(lastBlock)) {
		return lastSpan.contextRunStart ?? lastSpan.start;
	}
	if (appending) return sourceLength;

	const precedingSpanIndex = lastSpan?.end === sourceLength ? lastSpanIndex - 1 : lastSpanIndex;
	const precedingSpan = sourceSpans[precedingSpanIndex];
	const precedingBlock = blocks[precedingSpanIndex];
	if (
		precedingSpan?.end === sourceLength - 1 &&
		precedingBlock &&
		isProjectedContextBlock(precedingBlock)
	) {
		return precedingSpan.contextRunStart ?? precedingSpan.start;
	}
	return sourceLength - 1;
}

function projectedPrefixLength(spans: TranscriptProjectionSourceSpan[], sourceStart: number): number {
	let low = 0;
	let high = spans.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if ((spans[middle]?.end ?? 0) <= sourceStart) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return low;
}

function isProjectedContextBlock(block: ProjectedTranscriptBlock): boolean {
	return block.kind === "tool_group" || (block.kind !== "assistant_separator" && isContextBlock(block));
}

function isWorkActivity(block: MainTranscriptBlock): boolean {
	return block.kind === "tool" || block.kind === "bash" || block.kind === "file_change"
		|| block.kind === "web_search" || block.kind === "plan_update";
}

function createGroup(blocks: MainTranscriptBlock[]): ProjectedTranscriptBlock {
	const first = blocks[0];
	const last = blocks[blocks.length - 1];
	const id = `tool_group:${first?.id ?? "start"}:${last?.id ?? "end"}`;
	const items: CollapsedToolGroupItem[] = [];
	for (const block of blocks) {
		if (block.kind === "tool") {
			items.push({ kind: "tool", tool: block.tool });
		} else if (block.kind === "bash") {
			items.push({ kind: "bash", bash: block.bash });
		}
	}
	return { id, kind: "tool_group", group: { id, items } };
}

function isContextBlock(block: MycliShellTranscriptBlock): boolean {
	if (block.kind === "tool") {
		return toolContextActivity(block.tool) !== undefined;
	}
	return block.kind === "bash" && shellContextActivity(block.bash) !== undefined;
}

function isExpandedContextBlock(block: MycliShellTranscriptBlock): boolean {
	if (block.kind === "tool") {
		return Boolean(block.tool.expanded);
	}
	if (block.kind === "bash") {
		return Boolean(block.bash.expanded);
	}
	return false;
}
