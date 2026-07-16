import type { MycliShellTranscriptBlock, MycliShellTool } from "./model.ts";
import type { CollapsedToolGroup, CollapsedToolGroupItem } from "./components/collapsed-tool-group.ts";

type MainTranscriptBlock = Exclude<MycliShellTranscriptBlock, { kind: "subagent" }>;

export type ProjectedTranscriptBlock = MainTranscriptBlock | { id: string; kind: "tool_group"; group: CollapsedToolGroup };

const CONTEXT_TOOL_NAMES = new Set([
	"read",
	"grep",
	"search",
	"glob",
	"ls",
	"list",
]);

export function projectTranscriptBlocks(blocks: MycliShellTranscriptBlock[]): ProjectedTranscriptBlock[] {
	const projected: ProjectedTranscriptBlock[] = [];
	let pending: MainTranscriptBlock[] = [];

	const flushPending = (): void => {
		if (pending.length >= 2 && !pending.some(isExpandedContextBlock)) {
			projected.push(createGroup(pending));
		} else {
			projected.push(...pending);
		}
		pending = [];
	};

	for (const block of blocks) {
		if (block.kind === "subagent") {
			flushPending();
			continue;
		}
		if (isContextBlock(block)) {
			pending.push(block);
			continue;
		}
		flushPending();
		projected.push(block);
	}
	flushPending();
	return projected;
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
		return isContextTool(block.tool);
	}
	return false;
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

function isContextTool(tool: MycliShellTool): boolean {
	if (tool.hidden || tool.mutating) {
		return false;
	}
	if (tool.presentation === "context") {
		return true;
	}
	return CONTEXT_TOOL_NAMES.has(normalizeToolName(tool.name));
}

function normalizeToolName(name: string): string {
	return name.trim().toLowerCase().replace(/[_-]/g, "");
}
