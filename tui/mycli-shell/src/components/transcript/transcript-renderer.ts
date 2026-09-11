import type { MycliShellTranscriptBlock } from "../../model.ts";
import { projectTranscriptBlocks } from "../../transcript/transcript-projection.ts";
import { Container } from "../../tui-core/tui.ts";
import { createTranscriptBlockComponent } from "./transcript-block.ts";

export class TranscriptBlocksComponent extends Container {
	private readonly blockIds: string[] = [];

	constructor(blocks: MycliShellTranscriptBlock[], hideThinking?: boolean) {
		super();
		for (const block of projectTranscriptBlocks(blocks)) {
			this.addChild(createTranscriptBlockComponent(block, { hideThinking }));
			this.blockIds.push(block.id);
		}
	}

	renderWithRanges(width: number): RenderedTranscript {
		const lines: string[] = [];
		const blockRanges: TranscriptBlockRange[] = [];
		for (const [index, child] of this.children.entries()) {
			const start = lines.length;
			for (const line of child.render(width)) lines.push(line);
			blockRanges.push({ id: this.blockIds[index]!, start, end: lines.length });
		}
		return { lines, blockRanges };
	}
}

export function renderTranscriptBlocks(blocks: MycliShellTranscriptBlock[], width: number): string[] {
	return new TranscriptBlocksComponent(blocks).render(width);
}

export interface TranscriptBlockRange {
	readonly id: string;
	readonly start: number;
	readonly end: number;
}

export interface RenderedTranscript {
	readonly lines: string[];
	readonly blockRanges: readonly TranscriptBlockRange[];
}

export function renderTranscriptWithRanges(blocks: MycliShellTranscriptBlock[], width: number): RenderedTranscript {
	return new TranscriptBlocksComponent(blocks).renderWithRanges(width);
}
