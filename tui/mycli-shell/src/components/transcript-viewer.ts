import type {
	MycliShellBash,
	MycliShellTranscriptBlock,
	MycliShellTranscriptOutput,
} from "../model.ts";
import { renderTranscriptBlocks } from "../shell-app.ts";
import { matchesKey } from "../tui-core/keys.ts";
import type { Component } from "../tui-core/tui.ts";
import { truncateToWidth, visibleWidth } from "../tui-core/utils.ts";
import { theme } from "../theme/theme.ts";

const LEGACY_OUTPUT_NOTICE = "[Full output was not retained for this older session. Showing the saved tail.]";

export class TranscriptViewerComponent implements Component {
	private blocks: MycliShellTranscriptBlock[];
	private readonly shellOutputs = new Map<string, MycliShellTranscriptOutput>();
	private revision = 0;
	private contentRevision = -1;
	private contentWidth = 0;
	private contentLines: string[] = [];
	private scrollOffset = 0;
	private followingTail = true;
	private previousViewportRows = 0;
	private loadingCount = 0;
	private loadingHistory = false;
	private hasOlderHistory: boolean;
	private preserveScrollOffsetOnNextUpdate = false;
	private error: string | undefined;

	constructor(private readonly options: {
		readonly blocks: readonly MycliShellTranscriptBlock[];
		readonly rows: () => number;
		readonly sessionLabel?: string;
		readonly hasOlderHistory?: boolean;
		readonly onLoadOlder?: () => void;
		readonly onClose: () => void;
	}) {
		this.blocks = [...options.blocks];
		this.hasOlderHistory = options.hasOlderHistory === true;
	}

	updateBlocks(
		blocks: readonly MycliShellTranscriptBlock[],
		options: { readonly preserveScrollOffset?: boolean } = {},
	): void {
		this.blocks = [...blocks];
		this.preserveScrollOffsetOnNextUpdate = options.preserveScrollOffset === true;
		this.revision += 1;
	}

	setShellOutput(output: MycliShellTranscriptOutput): void {
		this.shellOutputs.set(shellOutputKey(output.shellId, output.callId), output);
		this.revision += 1;
	}

	setLoadingCount(count: number): void {
		this.loadingCount = Math.max(0, count);
		this.revision += 1;
	}

	setOlderHistoryState(input: { readonly available: boolean; readonly loading: boolean }): void {
		if (this.hasOlderHistory === input.available && this.loadingHistory === input.loading) return;
		this.hasOlderHistory = input.available;
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
		if (matchesKey(data, "escape") || data === "q") {
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
			this.contentLines = renderTranscriptBlocks(this.hydratedBlocks(), frameWidth);
			this.contentRevision = this.revision;
			this.contentWidth = frameWidth;
			if (!this.followingTail) {
				if (!this.preserveScrollOffsetOnNextUpdate) {
					this.scrollOffset = Math.max(0, this.contentLines.length - viewportRows - previousTop);
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
			padLine(this.footerLine(start, viewportRows), frameWidth),
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

	private hydratedBlocks(): MycliShellTranscriptBlock[] {
		return this.blocks.map((block) => {
			if (block.kind !== "bash") return block;
			return { ...block, bash: this.hydratedBash(block.bash) };
		});
	}

	private hydratedBash(bash: MycliShellBash): MycliShellBash {
		const output = bash.shellId
			? this.shellOutputs.get(shellOutputKey(bash.shellId, bash.callId))
			: undefined;
		if (output?.available) {
			return {
				...bash,
				outputPreview: output.output || bash.outputPreview,
				omittedOutputChars: output.omittedChars,
				hiddenLineCount: 0,
				expanded: true,
			};
		}
		const outputUnavailable = output?.available === false;
		const legacyNotice = outputUnavailable || (bash.omittedOutputChars ?? 0) > 0
			? `${LEGACY_OUTPUT_NOTICE}${bash.outputPreview ? `\n${bash.outputPreview}` : ""}`
			: bash.outputPreview;
		return {
			...bash,
			...(legacyNotice ? { outputPreview: legacyNotice } : {}),
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

	private footerLine(_start: number, _viewportRows: number): string {
		const status = this.error
			? theme.fg("error", this.error)
			: this.loadingHistory
				? theme.fg("muted", "Loading earlier history...")
			: this.loadingCount > 0
				? theme.fg("muted", `Loading ${this.loadingCount} Shell output${this.loadingCount === 1 ? "" : "s"}...`)
				: "";
		const keys = theme.fg("dim", "up/down scroll · pgup/pgdn page · home/end jump · esc/q close");
		return status ? `${status}  ${keys}` : keys;
	}
}

export function shellOutputKey(shellId: string, callId?: string): string {
	return `${shellId}\u0000${callId ?? ""}`;
}

function padLine(line: string, width: number): string {
	const fitted = visibleWidth(line) > width ? truncateToWidth(line, width, "...") : line;
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}
