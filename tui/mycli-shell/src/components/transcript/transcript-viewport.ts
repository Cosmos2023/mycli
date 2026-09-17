import { Container, type Component } from "../../tui-core/tui.ts";
import { visibleWidth } from "../../tui-core/utils.ts";

type TranscriptContentChange =
	| { kind: "full" }
	| { kind: "section_tail"; section: Container; stablePrefixLength: number };

type TranscriptRenderedChunk = {
	section: Container;
	componentIndex: number;
	start: number;
	sourceStart: number;
	totalLines: number;
};

type TranscriptChunkRender = {
	section: Container;
	componentIndex: number;
	lines: string[];
	totalLines: number;
};

type TranscriptChunkLayout = {
	chunks: TranscriptRenderedChunk[];
	lineOrigin: number;
};

type TranscriptTailRender = {
	lines: string[];
	chunks: TranscriptRenderedChunk[];
	lineOrigin: number;
	chunkOffset: number;
	continuesLineage: boolean;
	cacheable: boolean;
	truncated: boolean;
};

const RETAINED_CHUNK_COMPACTION_MIN_PREFIX = 1_024;

export class TranscriptViewportComponent implements Component {
	private scrollOffset = 0;
	private lastLineCount = 0;
	private lastRenderedLines: string[] = [];
	private lastRenderedWidth: number | undefined;
	private committedPrefixLength = 0;
	private committedPrefixBoundary: string | undefined;
	private committedWidth: number | undefined;
	private committedContentLineage: number | undefined;
	private committedLogicalEnd = 0;
	private committedAnchor: {
		readonly section: Container;
		readonly component: Component;
		readonly componentIndex: number;
		readonly rowOffset: number;
	} | undefined;
	private pendingScrollbackLineage: number | undefined;
	private pendingScrollbackStart = 0;
	private pendingScrollbackLines: string[] = [];
	private renderCache = new WeakMap<Component, {
		key: unknown;
		width: number;
		maxRows?: number;
		lines: string[];
		totalLines: number;
	}>();
	private retainedContentRevision: unknown;
	private retainedContentWidth: number | undefined;
	private retainedContentLines: string[] = [];
	private retainedContentChunks: TranscriptRenderedChunk[] = [];
	private retainedContentLineOrigin = 0;
	private retainedContentChunkOffset = 0;
	private retainedContentLineage = 0;
	private retainedContentTruncated = false;
	private retainedContentReady = false;
	private pendingContentChange: TranscriptContentChange | undefined;
	private lastRenderedLineOrigin = 0;
	private lastRenderedContentLineage: number | undefined;

	/**
	 * `contentRevision` must change before the owner mutates any transcript-visible content.
	 * Omit it when the owner cannot guarantee that contract; aggregate frame reuse then stays disabled.
	 */
	constructor(
		private readonly content: Container,
		private readonly heightForWidth: (width: number) => number,
		private readonly maxRenderedRows: number | undefined,
		private readonly contentRevision?: () => unknown,
	) {}

	markContentChanged(): void {
		this.pendingContentChange = { kind: "full" };
	}

	/** Record an owner-validated stable component prefix for the last content section. */
	markSectionTailChanged(section: Container, stablePrefixLength: number): void {
		if (!Number.isSafeInteger(stablePrefixLength) || stablePrefixLength < 0) {
			this.markContentChanged();
			return;
		}
		const prefix = stablePrefixLength;
		const pending = this.pendingContentChange;
		if (pending?.kind === "full") return;
		if (pending?.kind === "section_tail" && pending.section !== section) {
			this.pendingContentChange = { kind: "full" };
			return;
		}
		this.pendingContentChange = {
			kind: "section_tail",
			section,
			stablePrefixLength: pending?.kind === "section_tail"
				? Math.min(pending.stablePrefixLength, prefix)
				: prefix,
		};
	}

	getScrollOffset(): number {
		return this.scrollOffset;
	}

	scrollBy(deltaLines: number): void {
		this.scrollOffset = Math.max(0, this.scrollOffset + deltaLines);
	}

	scrollToBottom(): void {
		this.scrollOffset = 0;
	}

	scrollToLine(lineIndex: number, width: number): void {
		const lines = this.renderContent(width);
		const height = Math.max(1, this.heightForWidth(width));
		this.lastLineCount = lines.length;
		const target = Math.max(0, Math.min(lineIndex, Math.max(0, lines.length - 1)));
		this.scrollOffset = Math.max(0, lines.length - height - target);
	}

	scrollbackPrefix(width: number): string[] {
		const height = Math.max(1, this.heightForWidth(width));
		const lines = this.renderContent(width);
		this.scrollOffset = 0;
		this.lastLineCount = lines.length;
		const start = this.visibleStart(lines, height);
		this.recordCommittedPrefix(lines, start, width);
		return lines.slice(0, start);
	}

	scrollbackPrefixBefore(section: Container, componentIndex: number, width: number): string[] {
		const sectionIndex = this.content.children.indexOf(section);
		if (sectionIndex < 0) return [];
		// The excluded suffix still owns replay rows and live viewport cells.
		const suffixChunks: string[][] = [];
		const prefixChunks: string[][] = [];
		let renderedRows = 0;
		sections: for (let currentSectionIndex = this.content.children.length - 1; currentSectionIndex >= 0; currentSectionIndex -= 1) {
			const currentSection = this.content.children[currentSectionIndex]!;
			const components = currentSection instanceof Container ? currentSection.children : [currentSection];
			const targetIndex = currentSection === section
				? Math.max(0, Math.min(componentIndex, components.length - 1))
				: currentSectionIndex > sectionIndex
					? 0
					: components.length;
			const end = components.length;
			for (let index = end - 1; index >= 0; index -= 1) {
				const isSuffix = currentSectionIndex > sectionIndex || (currentSection === section && index >= targetIndex);
				const remaining = this.maxRenderedRows === undefined
					? undefined
					: this.maxRenderedRows - renderedRows;
				if (remaining !== undefined && remaining <= 0) break sections;
				const rendered = this.renderComponent(components[index]!, width, remaining);
				(isSuffix ? suffixChunks : prefixChunks).push(rendered.lines);
				renderedRows += rendered.lines.length;
			}
			if (this.maxRenderedRows !== undefined && renderedRows >= this.maxRenderedRows) break;
		}
		prefixChunks.reverse();
		suffixChunks.reverse();
		const prefixLines = prefixChunks.flat();
		const lines = [...prefixLines, ...suffixChunks.flat()];
		const height = Math.max(1, this.heightForWidth(width));
		return prefixLines.slice(0, Math.min(prefixLines.length, this.visibleStart(lines, height)));
	}

	discardPendingScrollbackLines(): void {
		this.clearPendingScrollbackLines();
	}

	takeNewScrollbackLines(width: number, refreshLines = false): string[] {
		if (this.scrollOffset !== 0 || (!refreshLines && this.lastRenderedWidth !== width)) return [];
		const height = Math.max(1, this.heightForWidth(width));
		const previousLines = this.lastRenderedLines;
		const previousStart = this.visibleStart(previousLines, height, this.committedStart(previousLines, width));
		const lines = refreshLines ? this.renderContent(width) : this.lastRenderedLines;
		this.lastLineCount = lines.length;
		const start = this.visibleStart(lines, height, this.committedStart(lines, width));
		const boundedWindowRolled =
			this.maxRenderedRows !== undefined &&
			previousLines.length >= this.maxRenderedRows &&
			lines.length >= this.maxRenderedRows;
		const logicalDelta = this.takeLogicalScrollbackDelta(lines, start, width);
		if (logicalDelta !== undefined) {
			this.recordCommittedPrefix(lines, start, width);
			return logicalDelta;
		}
		if (refreshLines && boundedWindowRolled && this.committedWidth === width && previousLines.length > 0) {
			const overlap = suffixPrefixOverlapLength(previousLines, lines);
			const droppedRows = previousLines.length - overlap;
			const delta = this.takePendingScrollbackLines();
			if (droppedRows > previousStart) {
				delta.push(...previousLines.slice(previousStart, droppedRows));
			}
			const survivingPreviousStart = Math.max(0, previousStart - droppedRows);
			delta.push(...lines.slice(survivingPreviousStart, start));
			this.recordCommittedPrefix(lines, start, width);
			return delta;
		}
		const pendingDelta = this.takePendingScrollbackLines();
		if (pendingDelta.length > 0) {
			this.recordCommittedPrefix(lines, start, width);
			return pendingDelta;
		}
		const boundaryChanged =
			this.committedPrefixLength > 0 &&
			lines[this.committedPrefixLength - 1] !== this.committedPrefixBoundary;
		if (
			this.committedWidth !== width ||
			start < this.committedPrefixLength ||
			boundaryChanged
		) {
			this.recordCommittedPrefix(lines, start, width);
			return [];
		}
		const delta = lines.slice(this.committedPrefixLength, start);
		this.recordCommittedPrefix(lines, start, width);
		return delta;
	}

	invalidate(): void {
		this.content.invalidate();
		this.renderCache = new WeakMap();
		this.retainedContentReady = false;
		this.retainedContentLines = [];
		this.retainedContentChunks = [];
		this.retainedContentLineOrigin = 0;
		this.retainedContentChunkOffset = 0;
		this.retainedContentLineage += 1;
		this.retainedContentTruncated = false;
		this.retainedContentWidth = undefined;
		this.pendingContentChange = undefined;
		this.lastRenderedContentLineage = undefined;
		this.clearPendingScrollbackLines();
	}

	render(width: number): string[] {
		const height = Math.max(1, this.heightForWidth(width));
		const widthChanged = this.lastRenderedWidth !== undefined && this.lastRenderedWidth !== width;
		const lines = this.renderContent(width);
		if (!widthChanged && lines.length > this.lastLineCount) {
			this.scrollOffset = 0;
		}
		this.lastLineCount = lines.length;
		this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, lines.length - height));

		const start = this.visibleStart(lines, height, this.committedStart(lines, width));
		// The enclosing transcript area adds spare rows after live activity so
		// activity follows output while the input stays at the bottom.
		return lines.slice(start, start + height);
	}

	private committedStart(lines: string[], width: number): number {
		if (this.scrollOffset !== 0 || this.committedWidth !== width) return 0;
		if (
			this.lastRenderedContentLineage !== undefined &&
			this.lastRenderedContentLineage === this.committedContentLineage
		) {
			return Math.max(0, Math.min(lines.length, this.committedLogicalEnd - this.lastRenderedLineOrigin));
		}
		return this.committedAnchor === undefined && this.committedPrefixLength > 0 &&
			lines[this.committedPrefixLength - 1] === this.committedPrefixBoundary
			? this.committedPrefixLength
			: 0;
	}

	private visibleStart(lines: string[], height: number, committedStart: number = 0): number {
		let start = Math.max(0, lines.length - height - this.scrollOffset);
		if (this.scrollOffset === 0) {
			while (start > 0 && lines.slice(start, start + height).every(isVisuallyBlankLine)) {
				start -= 1;
			}
		}
		// Native history cannot move back into the live frame when shell chrome shrinks.
		return Math.max(start, committedStart);
	}

	private renderContent(width: number): string[] {
		const revision = this.contentRevision?.();
		const pendingChange = this.pendingContentChange;
		let lines: string[];
		if (
			this.maxRenderedRows !== undefined &&
			this.contentRevision !== undefined &&
			pendingChange === undefined &&
			this.retainedContentReady &&
			this.retainedContentWidth === width &&
			Object.is(this.retainedContentRevision, revision)
		) {
			lines = this.retainedContentLines;
		} else if (this.maxRenderedRows === undefined) {
			lines = this.content.render(width);
			this.retainedContentReady = false;
		} else {
			const incremental =
				pendingChange?.kind === "section_tail" &&
				this.retainedContentReady &&
				this.retainedContentWidth === width
					? this.renderContentTailUpdate(width, this.maxRenderedRows, pendingChange)
					: undefined;
			const rendered = incremental ?? this.renderContentTail(width, this.maxRenderedRows);
			if (incremental === undefined || !rendered.continuesLineage) {
				this.retainedContentLineage += 1;
			}
			lines = rendered.lines;
			this.retainedContentRevision = revision;
			this.retainedContentWidth = width;
			this.retainedContentLines = lines;
			this.retainedContentChunks = rendered.chunks;
			this.retainedContentLineOrigin = rendered.lineOrigin;
			this.retainedContentChunkOffset = rendered.chunkOffset;
			this.retainedContentTruncated = rendered.truncated;
			this.retainedContentReady = this.contentRevision !== undefined && rendered.cacheable;
		}
		this.pendingContentChange = undefined;
		this.lastRenderedLines = lines;
		this.lastRenderedWidth = width;
		this.lastRenderedLineOrigin = this.maxRenderedRows === undefined
			? 0
			: this.retainedContentLineOrigin;
		this.lastRenderedContentLineage = this.maxRenderedRows === undefined
			? undefined
			: this.retainedContentLineage;
		this.rebaseCommittedPrefix(width, lines);
		return lines;
	}

	private rebaseCommittedPrefix(width: number, lines: string[]): void {
		// A bounded rebuild can change the logical origin while retaining the source component.
		const anchor = this.committedAnchor;
		if (
			!anchor || this.committedWidth !== width ||
			this.lastRenderedContentLineage === undefined ||
			this.lastRenderedContentLineage === this.committedContentLineage ||
			anchor.section.children[anchor.componentIndex] !== anchor.component
		) return;
		const chunk = this.retainedContentChunks.find((candidate) =>
			candidate.section === anchor.section && candidate.componentIndex === anchor.componentIndex);
		if (!chunk || anchor.rowOffset > chunk.totalLines) return;
		const logicalEnd = chunk.sourceStart + anchor.rowOffset;
		const start = logicalEnd - this.lastRenderedLineOrigin;
		if (start < 0 || start > lines.length) return;
		if (start > 0 && lines[start - 1] !== this.committedPrefixBoundary) return;
		if (this.pendingScrollbackLineage === this.committedContentLineage) {
			this.pendingScrollbackStart += logicalEnd - this.committedLogicalEnd;
			this.pendingScrollbackLineage = this.lastRenderedContentLineage;
		}
		this.committedPrefixLength = start;
		this.committedLogicalEnd = logicalEnd;
		this.committedContentLineage = this.lastRenderedContentLineage;
	}

	private renderContentTail(width: number, maxRows: number): TranscriptTailRender {
		const chunks: TranscriptChunkRender[] = [];
		let renderedRows = 0;
		let cacheable = true;
		let truncated = false;
		for (let sectionIndex = this.content.children.length - 1; sectionIndex >= 0; sectionIndex -= 1) {
			const section = this.content.children[sectionIndex]!;
			const components = section instanceof Container ? section.children : [section];
			for (let index = components.length - 1; index >= 0; index -= 1) {
				const rendered = this.renderComponent(components[index]!, width, maxRows - renderedRows);
				chunks.push({
					section: section instanceof Container ? section : this.content,
					componentIndex: index,
					lines: rendered.lines,
					totalLines: rendered.totalLines,
				});
				renderedRows += rendered.lines.length;
				cacheable &&= rendered.cacheable;
				truncated ||= rendered.totalLines > rendered.lines.length;
				if (renderedRows >= maxRows) {
					truncated ||= index > 0 || sectionIndex > 0;
					break;
				}
			}
			if (renderedRows >= maxRows) break;
		}
		chunks.reverse();
		const lines = chunks.flatMap((chunk) => chunk.lines);
		const layout = this.layoutRenderedChunks(chunks, 0);
		return {
			lines,
			chunks: layout.chunks,
			lineOrigin: layout.lineOrigin,
			chunkOffset: 0,
			continuesLineage: false,
			cacheable,
			truncated,
		};
	}

	private renderContentTailUpdate(
		width: number,
		maxRows: number,
		change: Extract<TranscriptContentChange, { kind: "section_tail" }>,
	): TranscriptTailRender | undefined {
		if (this.content.children.at(-1) !== change.section) return undefined;
		if (change.stablePrefixLength > change.section.children.length) return undefined;

		let chunkBoundary = this.retainedContentChunks.length;
		while (chunkBoundary > this.retainedContentChunkOffset) {
			const chunk = this.retainedContentChunks[chunkBoundary - 1]!;
			if (chunk.section !== change.section || chunk.componentIndex < change.stablePrefixLength) break;
			chunkBoundary -= 1;
		}
		const firstChangedChunk = this.retainedContentChunks[chunkBoundary];
		const lineBoundary = firstChangedChunk?.section === change.section
			? Math.max(
				0,
				Math.min(
					this.retainedContentLines.length,
					firstChangedChunk.start - this.retainedContentLineOrigin,
				),
			)
			: this.retainedContentLines.length;

		const suffixChunks: TranscriptChunkRender[] = [];
		let renderedRows = 0;
		let cacheable = true;
		let truncated = false;
		for (let index = change.section.children.length - 1; index >= change.stablePrefixLength; index -= 1) {
			const rendered = this.renderComponent(
				change.section.children[index]!,
				width,
				maxRows - renderedRows,
			);
			suffixChunks.push({
				section: change.section,
				componentIndex: index,
				lines: rendered.lines,
				totalLines: rendered.totalLines,
			});
			renderedRows += rendered.lines.length;
			cacheable &&= rendered.cacheable;
			truncated ||= rendered.totalLines > rendered.lines.length;
			if (renderedRows >= maxRows) {
				truncated ||= index > change.stablePrefixLength || change.stablePrefixLength > 0;
				break;
			}
		}
		suffixChunks.reverse();
		const suffixLines = suffixChunks.flatMap((chunk) => chunk.lines);
		const suffixCoversBoundary = suffixChunks[0]?.componentIndex === change.stablePrefixLength;
		const suffixSourceStart =
			firstChangedChunk?.section === change.section &&
			firstChangedChunk.componentIndex === change.stablePrefixLength
				? firstChangedChunk.sourceStart
				: firstChangedChunk === undefined
					? this.retainedContentLineOrigin + lineBoundary
					: undefined;
		if (suffixLines.length >= maxRows) {
			let layout: TranscriptChunkLayout | undefined;
			let continuesLineage = false;
			if (suffixCoversBoundary && suffixSourceStart !== undefined) {
				const candidate = this.layoutRenderedChunks(suffixChunks, suffixSourceStart);
				const retainedEnd = this.retainedContentLineOrigin + this.retainedContentLines.length;
				if (
					candidate.lineOrigin >= this.retainedContentLineOrigin &&
					candidate.lineOrigin <= retainedEnd
				) {
					layout = candidate;
					continuesLineage = true;
					this.retainDisplacedScrollbackLines(width, this.retainedContentLines, candidate.lineOrigin);
				}
			}
			layout ??= this.layoutRenderedChunks(suffixChunks, 0);
			return {
				lines: suffixLines,
				chunks: layout.chunks,
				lineOrigin: layout.lineOrigin,
				chunkOffset: 0,
				continuesLineage,
				cacheable,
				truncated: true,
			};
		}

		const combinedLines = [...this.retainedContentLines.slice(0, lineBoundary), ...suffixLines];
		const nextLineCount = combinedLines.length;
		if (nextLineCount < maxRows && this.retainedContentTruncated) return undefined;

		const trimmedRows = Math.max(0, nextLineCount - maxRows);
		const lines = trimmedRows > 0 ? combinedLines.slice(trimmedRows) : combinedLines;
		const lineOrigin = this.retainedContentLineOrigin + trimmedRows;
		this.retainDisplacedScrollbackLines(width, combinedLines, lineOrigin);
		const suffixLayout = this.layoutRenderedChunks(
			suffixChunks,
			suffixSourceStart ?? this.retainedContentLineOrigin + lineBoundary,
		);
		const chunks = this.retainedContentChunks;
		chunks.splice(chunkBoundary, chunks.length - chunkBoundary, ...suffixLayout.chunks);
		let chunkOffset = this.trimRetainedChunkPrefix(
			chunks,
			this.retainedContentChunkOffset,
			lineOrigin,
			lineOrigin + lines.length,
		);
		if (
			chunkOffset >= RETAINED_CHUNK_COMPACTION_MIN_PREFIX &&
			chunkOffset * 2 >= chunks.length
		) {
			chunks.splice(0, chunkOffset);
			chunkOffset = 0;
		}
		return {
			lines,
			chunks,
			lineOrigin,
			chunkOffset,
			continuesLineage: true,
			cacheable,
			truncated: this.retainedContentTruncated || truncated || trimmedRows > 0,
		};
	}

	private layoutRenderedChunks(
		chunks: TranscriptChunkRender[],
		sourceStart: number,
	): TranscriptChunkLayout {
		let cursor = sourceStart;
		let lineOrigin = sourceStart;
		const metadata = chunks.map((chunk, index): TranscriptRenderedChunk => {
			const start = cursor + Math.max(0, chunk.totalLines - chunk.lines.length);
			if (index === 0) lineOrigin = start;
			const result = {
				section: chunk.section,
				componentIndex: chunk.componentIndex,
				start,
				sourceStart: cursor,
				totalLines: chunk.totalLines,
			};
			cursor += chunk.totalLines;
			return result;
		});
		return { chunks: metadata, lineOrigin };
	}

	private trimRetainedChunkPrefix(
		chunks: TranscriptRenderedChunk[],
		chunkOffset: number,
		lineOrigin: number,
		logicalEnd: number,
	): number {
		let offset = chunkOffset;
		while (offset < chunks.length) {
			const nextStart = chunks[offset + 1]?.start ?? logicalEnd;
			if (nextStart > lineOrigin) break;
			offset += 1;
		}
		return offset;
	}

	private retainDisplacedScrollbackLines(
		width: number,
		combinedLines: string[],
		nextLineOrigin: number,
	): void {
		if (
			this.committedWidth !== width ||
			this.committedContentLineage !== this.retainedContentLineage ||
			nextLineOrigin <= this.retainedContentLineOrigin
		) {
			return;
		}
		const pendingEnd = this.pendingScrollbackLineage === this.retainedContentLineage
			? this.pendingScrollbackStart + this.pendingScrollbackLines.length
			: this.committedLogicalEnd;
		const start = Math.max(this.retainedContentLineOrigin, pendingEnd);
		if (start >= nextLineOrigin) return;
		const displaced = combinedLines.slice(
			start - this.retainedContentLineOrigin,
			nextLineOrigin - this.retainedContentLineOrigin,
		);
		if (displaced.length === 0) return;
		if (this.pendingScrollbackLineage !== this.retainedContentLineage) {
			this.pendingScrollbackLineage = this.retainedContentLineage;
			this.pendingScrollbackStart = start;
			this.pendingScrollbackLines = displaced;
			return;
		}
		this.pendingScrollbackLines.push(...displaced);
	}

	private takeLogicalScrollbackDelta(
		lines: string[],
		start: number,
		width: number,
	): string[] | undefined {
		const lineage = this.lastRenderedContentLineage;
		if (
			lineage === undefined ||
			lineage !== this.committedContentLineage ||
			this.committedWidth !== width
		) {
			return undefined;
		}
		const logicalEnd = this.lastRenderedLineOrigin + start;
		if (logicalEnd < this.committedLogicalEnd) return undefined;

		const hasPending =
			this.pendingScrollbackLines.length > 0 &&
			this.pendingScrollbackLineage === lineage;
		if (hasPending && this.pendingScrollbackStart !== this.committedLogicalEnd) return undefined;
		const pendingEnd = hasPending
			? this.pendingScrollbackStart + this.pendingScrollbackLines.length
			: this.committedLogicalEnd;
		if (pendingEnd < this.lastRenderedLineOrigin || pendingEnd > logicalEnd) return undefined;
		const delta = this.takePendingScrollbackLines(lineage);
		delta.push(...lines.slice(
			pendingEnd - this.lastRenderedLineOrigin,
			logicalEnd - this.lastRenderedLineOrigin,
		));
		return delta;
	}

	private takePendingScrollbackLines(lineage?: number): string[] {
		if (
			this.pendingScrollbackLines.length === 0 ||
			(lineage !== undefined && this.pendingScrollbackLineage !== lineage)
		) {
			return [];
		}
		const lines = this.pendingScrollbackLines;
		this.clearPendingScrollbackLines();
		return lines;
	}

	private clearPendingScrollbackLines(): void {
		this.pendingScrollbackLineage = undefined;
		this.pendingScrollbackStart = 0;
		this.pendingScrollbackLines = [];
	}

	private renderComponent(
		component: Component,
		width: number,
		maxRows?: number,
	): { lines: string[]; totalLines: number; cacheable: boolean } {
		const key = component.getRenderCacheKey?.();
		if (key === undefined) {
			return { ...this.renderComponentLines(component, width, maxRows), cacheable: false };
		}

		const cached = this.renderCache.get(component);
		if (cached && cached.width === width && cached.maxRows === maxRows && Object.is(cached.key, key)) {
			return { lines: cached.lines, totalLines: cached.totalLines, cacheable: true };
		}
		const rendered = this.renderComponentLines(component, width, maxRows);
		this.renderCache.set(component, { key, width, maxRows, ...rendered });
		return { ...rendered, cacheable: true };
	}

	private renderComponentLines(
		component: Component,
		width: number,
		maxRows?: number,
	): { lines: string[]; totalLines: number } {
		if (maxRows !== undefined) {
			if (maxRows <= 0) return { lines: [], totalLines: 0 };
			if (component.renderTail) return component.renderTail(width, maxRows);
			const lines = component.render(width);
			return { lines: lines.slice(-maxRows), totalLines: lines.length };
		}
		const lines = component.render(width);
		return { lines, totalLines: lines.length };
	}

	private recordCommittedPrefix(lines: string[], start: number, width: number): void {
		this.committedPrefixLength = start;
		this.committedPrefixBoundary = start > 0 ? lines[start - 1] : undefined;
		this.committedWidth = width;
		this.committedContentLineage = this.lastRenderedContentLineage;
		this.committedLogicalEnd = this.lastRenderedLineOrigin + start;
		this.committedAnchor = undefined;
		if (start > 0 && this.lastRenderedContentLineage !== undefined) {
			// Locate the boundary without scanning stable chunks on every streaming delta.
			let lower = this.retainedContentChunkOffset;
			let upper = this.retainedContentChunks.length;
			while (lower < upper) {
				const middle = Math.floor((lower + upper) / 2);
				if (this.retainedContentChunks[middle]!.start < this.committedLogicalEnd) lower = middle + 1;
				else upper = middle;
			}
			const chunk = this.retainedContentChunks[lower - 1];
			const component = chunk?.section.children[chunk.componentIndex];
			if (chunk && component) {
				this.committedAnchor = {
					section: chunk.section,
					component,
					componentIndex: chunk.componentIndex,
					rowOffset: this.committedLogicalEnd - chunk.sourceStart,
				};
			}
		}
		this.clearPendingScrollbackLines();
	}
}

function isVisuallyBlankLine(line: string): boolean {
	return visibleWidth(line.replace(/\s/g, "")) === 0;
}

function suffixPrefixOverlapLength(previousLines: string[], nextLines: string[]): number {
	if (previousLines.length === 0 || nextLines.length === 0) return 0;
	const prefix = new Array<number>(nextLines.length).fill(0);
	for (let index = 1; index < nextLines.length; index += 1) {
		let matched = prefix[index - 1] ?? 0;
		while (matched > 0 && nextLines[index] !== nextLines[matched]) {
			matched = prefix[matched - 1] ?? 0;
		}
		if (nextLines[index] === nextLines[matched]) matched += 1;
		prefix[index] = matched;
	}

	let matched = 0;
	for (let index = 0; index < previousLines.length; index += 1) {
		const line = previousLines[index]!;
		while (matched > 0 && line !== nextLines[matched]) {
			matched = prefix[matched - 1] ?? 0;
		}
		if (line === nextLines[matched]) matched += 1;
		if (matched === nextLines.length && index < previousLines.length - 1) {
			matched = prefix[matched - 1] ?? 0;
		}
	}
	return matched;
}
