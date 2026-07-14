import type { MycliShellSubagent, MycliShellTranscriptBlock, MycliShellTool } from "./model.ts";
import type { CollapsedToolGroup, CollapsedToolGroupItem } from "./components/collapsed-tool-group.ts";
import type { SubagentGroup } from "./components/subagent-execution.ts";

export type ProjectedTranscriptBlock =
	| MycliShellTranscriptBlock
	| { id: string; kind: "tool_group"; group: CollapsedToolGroup }
	| { id: string; kind: "agent_group"; group: SubagentGroup };

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
	let pending: MycliShellTranscriptBlock[] = [];

	const flushPending = (): void => {
		if (pending.length >= 2 && !pending.some(isExpandedContextBlock)) {
			projected.push(createGroup(pending));
		} else {
			projected.push(...pending);
		}
		pending = [];
	};

	for (const block of blocks) {
		if (isResolvedSubagentBlock(block)) {
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
	return groupSubagents(projected);
}

function isResolvedSubagentBlock(block: MycliShellTranscriptBlock): boolean {
	if (block.kind !== "subagent") {
		return false;
	}
	return isResolvedSubagent(block.subagent);
}

function createGroup(blocks: MycliShellTranscriptBlock[]): ProjectedTranscriptBlock {
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
	return CONTEXT_TOOL_NAMES.has(normalizeToolName(tool.name));
}

function normalizeToolName(name: string): string {
	return name.trim().toLowerCase().replace(/[_-]/g, "");
}

function groupSubagents(blocks: ProjectedTranscriptBlock[]): ProjectedTranscriptBlock[] {
	const grouped: ProjectedTranscriptBlock[] = [];
	let pending: MycliShellSubagent[] = [];

	const flush = (): void => {
		if (pending.length >= 2) {
			grouped.push(createSubagentGroup(pending));
		} else if (pending.length === 1) {
			const agent = pending[0]!;
			grouped.push({ id: agent.id, kind: "subagent", subagent: agent });
		}
		pending = [];
	};

	for (const block of blocks) {
		if (block.kind !== "subagent") {
			flush();
			grouped.push(block);
			continue;
		}
		const previous = pending.at(-1);
		if (previous && subagentGroupKey(previous) !== subagentGroupKey(block.subagent)) {
			flush();
		}
		pending.push(block.subagent);
	}
	flush();
	return grouped;
}

function createSubagentGroup(agents: MycliShellSubagent[]): ProjectedTranscriptBlock {
	const first = agents[0];
	const last = agents[agents.length - 1];
	const key = first ? subagentGroupKey(first) : "agents";
	const id = `agent_group:${key}:${last?.id ?? "end"}`;
	return { id, kind: "agent_group", group: { id, agents } };
}

function subagentGroupKey(agent: MycliShellSubagent): string {
	return agent.parentTurnId || agent.id;
}

function isResolvedSubagent(agent: MycliShellSubagent): boolean {
	const normalized = agent.status.toLowerCase();
	return !["running", "pending", "queued"].includes(normalized);
}
