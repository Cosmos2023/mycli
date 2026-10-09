import type { MycliShellMessage, MycliShellState, MycliShellTool } from "../model.ts";

export type TranscriptCopyKind = "user" | "assistant" | "tool" | "notice";

export interface TranscriptCopyBlock {
	/** 1 is the newest copyable block; `/copy <n>` uses this index. */
	readonly index: number;
	readonly kind: TranscriptCopyKind;
	readonly label: string;
	/** Exact text placed on the clipboard: assistant and user blocks keep their Markdown source. */
	readonly text: string;
}

interface Candidate {
	readonly kind: TranscriptCopyKind;
	readonly label: string;
	readonly text: string;
}

/**
 * Copyable blocks in transcript order.
 *
 * Copying uses the stored source text rather than rendered rows, so tables, code fences and
 * emphasis survive the clipboard unchanged.
 */
export function transcriptCopyBlocks(state: MycliShellState): readonly TranscriptCopyBlock[] {
	const candidates = state.transcript?.length
		? state.transcript.flatMap((block) => candidateFromBlock(block))
		: [...state.messages.map(messageCandidate), ...state.tools.map(toolCandidate)];
	const usable = candidates.filter((candidate) => candidate.text.trim().length > 0);
	return Object.freeze(usable.map((candidate, position) => Object.freeze({
		index: usable.length - position,
		kind: candidate.kind,
		label: candidate.label,
		text: candidate.text,
	})));
}

/** Whole-conversation copy: user and assistant turns only, separated by role headers. */
export function transcriptCopyText(state: MycliShellState): string {
	const sections: string[] = [];
	for (const message of state.messages) {
		const text = message.text.trim();
		if (!text || (message.role !== "user" && message.role !== "assistant")) continue;
		sections.push(`${message.role === "user" ? "## User" : "## Assistant"}\n${text}`);
	}
	return sections.join("\n\n");
}

/** Human-readable summary used when an index is missing or out of range. */
export function transcriptCopyIndexHint(blocks: readonly TranscriptCopyBlock[], limit = 8): string {
	if (blocks.length === 0) return "Nothing copyable yet.";
	return blocks.slice(0, limit)
		.map((block) => `${block.index}=${block.label}`)
		.join(", ");
}

function candidateFromBlock(block: NonNullable<MycliShellState["transcript"]>[number]): Candidate[] {
	switch (block.kind) {
		case "message":
			return [messageCandidate(block.message)];
		case "file_change":
			return [messageCandidate(block.message)];
		case "tool":
			return [toolCandidate(block.tool)];
		case "plan":
			return [{ kind: "notice", label: "plan", text: block.plan.text }];
		case "plan_update":
			return [{ kind: "notice", label: "plan update",
				text: [block.planUpdate.title,
					...block.planUpdate.steps.map((step) => `- [${step.status === "completed" ? "x" : " "}] ${step.text}`),
				].join("\n") }];
		case "clarification":
			return [{ kind: "notice", label: "answer", text: block.clarification.response }];
		default:
			return [];
	}
}

function messageCandidate(message: MycliShellMessage): Candidate {
	const kind: TranscriptCopyKind = message.role === "user" ? "user"
		: message.role === "assistant" ? "assistant" : "notice";
	return { kind, label: message.role, text: message.text };
}

function toolCandidate(tool: MycliShellTool): Candidate {
	const body = [tool.args, tool.outputPreview, tool.summaryPreview, tool.contentPreview]
		.find((value) => typeof value === "string" && value.trim().length > 0);
	return { kind: "tool", label: `${tool.name} (${tool.status})`,
		text: [tool.name, body].filter((value) => typeof value === "string" && value.length > 0).join("\n") };
}
