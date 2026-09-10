import type {
	MycliShellBash,
	MycliShellTranscriptBlock,
} from "../../model.ts";
import {
	renderTranscriptWithRanges,
	type TranscriptBlockRange,
} from "./transcript-renderer.ts";
import { matchesKey } from "../../tui-core/keys.ts";
import type { Component } from "../../tui-core/tui.ts";
import { truncateToWidth, visibleWidth } from "../../tui-core/utils.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme } from "../../theme/theme.ts";

export class TranscriptViewerComponent implements Component {
	private blocks: MycliShellTranscriptBlock[];
	private revision = 0;
	private contentRevision = -1;
	private contentWidth = 0;
	private contentLines: string[] = [];
	private blockRanges: readonly TranscriptBlockRange[] = [];
	private scrollOffset = 0;
	private followingTail = true;
	private previousViewportRows = 0;
	private loadingHistory = false;
	private hasOlderHistory: boolean;
	private hasOlderAttempts: boolean;
	private preserveScrollOffsetOnNextUpdate = false;
	private error: string | undefined;

	constructor(private readonly options: {
		readonly blocks: readonly MycliShellTranscriptBlock[];
		readonly rows: () => number;
		readonly sessionLabel?: string;
		readonly hasOlderHistory?: boolean;
		readonly hasOlderAttempts?: boolean;
		readonly onLoadOlder?: () => void;
		readonly isToggleKey?: (data: string) => boolean;
		readonly onClose: () => void;
	}) {
		this.blocks = [...options.blocks];
		this.hasOlderHistory = options.hasOlderHistory === true;
		this.hasOlderAttempts = options.hasOlderAttempts === true;
	}

	updateBlocks(
		blocks: readonly MycliShellTranscriptBlock[],
		options: { readonly preserveScrollOffset?: boolean } = {},
	): void {
		this.blocks = [...blocks];
		this.preserveScrollOffsetOnNextUpdate = options.preserveScrollOffset === true;
		this.revision += 1;
	}

	setOlderHistoryState(input: { readonly available: boolean; readonly loading: boolean; readonly retryHistoryAvailable?: boolean }): void {
		if (this.hasOlderHistory === input.available && this.loadingHistory === input.loading
			&& this.hasOlderAttempts === (input.retryHistoryAvailable === true)) return;
		this.hasOlderHistory = input.available;
		this.hasOlderAttempts = input.retryHistoryAvailable === true;
		this.loadingHistory = input.loading;
		this.revision += 1;
	}

	setError(error: string | undefined): void {
		this.error = error;
		this.revision += 1;
	}

	getScrollOffset(): number {
		return this.scrollOffset;
	}

	invalidate(): void {
		this.contentRevision = -1;
	}

	getRenderCacheKey(): number {
		return this.revision;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "ctrl+c")
			|| this.options.isToggleKey?.(data)) {
			this.options.onClose();
			return;
		}
		const page = Math.max(1, this.previousViewportRows - 1);
		if (matchesKey(data, "up") || data === "k") {
			this.scrollBy(1);
		} else if (matchesKey(data, "down") || data === "j") {
			this.scrollBy(-1);
		} else if (matchesKey(data, "pageUp")) {
			this.scrollBy(page);
		} else if (matchesKey(data, "pageDown")) {
			this.scrollBy(-page);
		} else if (matchesKey(data, "home") || data === "g") {
			this.followingTail = false;
			this.scrollOffset = Number.MAX_SAFE_INTEGER;
			this.maybeLoadOlder();
		} else if (matchesKey(data, "end") || data === "G") {
			this.followingTail = true;
			this.scrollOffset = 0;
		}
	}

	render(width: number): string[] {
		const frameWidth = Math.max(1, width - 1);
		const frameRows = Math.max(3, this.options.rows());
		const viewportRows = Math.max(1, frameRows - 2);
		const previousTop = Math.max(
			0,
			this.contentLines.length - this.previousViewportRows - this.scrollOffset,
		);
		const contentChanged = this.contentRevision !== this.revision || this.contentWidth !== frameWidth;
		if (contentChanged) {
			const anchor = this.blockRanges.find((range) => range.start <= previousTop && range.end > previousTop);
			const rendered = renderTranscriptWithRanges(this.expandedBlocks(), frameWidth);
			this.contentLines = rendered.lines;
			this.blockRanges = rendered.blockRanges;
			this.contentRevision = this.revision;
			this.contentWidth = frameWidth;
			if (!this.followingTail) {
				if (!this.preserveScrollOffsetOnNextUpdate) {
					const movedAnchor = anchor && this.blockRanges.find((range) => range.id === anchor.id);
					const top = anchor && movedAnchor ? movedAnchor.start + previousTop - anchor.start : previousTop;
					this.scrollOffset = Math.max(0, this.contentLines.length - viewportRows - top);
				}
			}
			this.preserveScrollOffsetOnNextUpdate = false;
		}
		const maxOffset = Math.max(0, this.contentLines.length - viewportRows);
		this.scrollOffset = this.followingTail
			? 0
			: Math.min(this.scrollOffset, maxOffset);
		this.followingTail = this.scrollOffset === 0;
		const start = Math.max(0, this.contentLines.length - viewportRows - this.scrollOffset);
		const visible = this.contentLines.slice(start, start + viewportRows);
		while (visible.length < viewportRows) visible.push("");
		this.previousViewportRows = viewportRows;
		return [
			padLine(this.headerLine(start, visible.length), frameWidth),
			...visible.map((line) => padLine(line, frameWidth)),
			padLine(this.footerLine(), frameWidth),
		];
	}

	private scrollBy(delta: number): void {
		this.scrollOffset = Math.max(0, this.scrollOffset + delta);
		this.followingTail = this.scrollOffset === 0;
		if (delta > 0) this.maybeLoadOlder();
	}

	private maybeLoadOlder(): void {
		if (this.scrollOffset >= Math.max(0, this.contentLines.length - this.previousViewportRows)
			&& this.hasOlderHistory
			&& !this.loadingHistory) {
			this.options.onLoadOlder?.();
		}
	}

	private expandedBlocks(): MycliShellTranscriptBlock[] {
		return this.blocks.map((block) => {
			if (block.kind === "message" && (block.message.role === "warning" || block.message.role === "error")) {
				return { ...block, message: { ...block.message, diagnostic: { ...block.message.diagnostic, expanded: true } } };
			}
			if (block.kind === "provider_attempt") return { ...block, providerAttempt: { ...block.providerAttempt, expanded: true } };
			if (block.kind === "tool") return { ...block, tool: { ...block.tool, expanded: true } };
			if (block.kind !== "bash") return block;
			return { ...block, bash: this.expandedBash(block.bash) };
		});
	}

	private expandedBash(bash: MycliShellBash): MycliShellBash {
		const truncated = (bash.omittedOutputChars ?? 0) > 0 || (bash.hiddenLineCount ?? 0) > 0;
		const notice = truncated ? "[Output truncated. Showing retained output.]" : undefined;
		const preview = notice
			? `${notice}${bash.outputPreview ? `\n${bash.outputPreview}` : ""}`
			: bash.outputPreview;
		return {
			...bash,
			...(preview ? { outputPreview: preview } : {}),
			hiddenLineCount: 0,
			expanded: true,
		};
	}

	private headerLine(start: number, visibleRows: number): string {
		const label = this.options.sessionLabel?.trim();
		const end = Math.min(this.contentLines.length, start + visibleRows);
		const range = this.contentLines.length === 0 ? "0 lines" : `${start + 1}-${end}/${this.contentLines.length}`;
		return `${theme.fg("accent", theme.bold("Transcript"))}${label ? theme.fg("muted", `  ${label}`) : ""}${theme.fg("dim", `  ${range}`)}`;
	}

	private footerLine(): string {
		const status = this.error
			? theme.fg("error", this.error)
			: this.loadingHistory
				? theme.fg("muted", "Loading earlier history...")
				: this.hasOlderAttempts ? theme.fg("muted", "Earlier retries: Home")
				: "";
		const separator = ` ${uiGlyphs().separator} `;
		const keys = theme.fg("dim", ["up/down scroll", "pgup/pgdn page", "home/end jump", "esc/q close"].join(separator));
		return status ? `${status}  ${keys}` : keys;
	}
}

function padLine(line: string, width: number): string {
	const fitted = visibleWidth(line) > width ? truncateToWidth(line, width, "...") : line;
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}
