import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme } from "../../theme/theme.ts";
import { Text } from "../../tui-core/components/text.ts";
import { TUI, type Component } from "../../tui-core/tui.ts";
import { truncateToWidth } from "../../tui-core/utils.ts";
import { keyForAction } from "../shared/keybinding-hints.ts";
import { TRANSCRIPT_HEADER_INDENT } from "./transcript-gutter.ts";
import { turnActivityHeaderText } from "./turn-activity-label.ts";
import { elapsedSecondsFor, formatElapsedCompact } from "./turn-completed.ts";

type TurnActivityStatus = {
	text: string;
	kind?: string;
	detail?: string;
	retryAt?: string;
};

export class TurnActivityComponent implements Component {
	private readonly frames: readonly string[];
	private frameIndex = 0;
	private intervalId: NodeJS.Timeout | null = null;
	private cachedWidth: number | null = null;
	private cachedFrameIndex: number | null = null;
	private cachedElapsedSeconds: number | null = null;
	private cachedLines: string[] = [];
	private renderRevision = 0;

	constructor(
		private readonly ui: TUI,
		private startedAtMs: number,
		private readonly now: () => number,
		private status: TurnActivityStatus,
		private readonly animated: boolean,
	) {
		const glyphs = uiGlyphs();
		this.frames = animated ? glyphs.spinnerFrames : [glyphs.staticProgress];
		this.start();
	}

	stop(): void {
		if (!this.intervalId) {
			return;
		}
		clearInterval(this.intervalId);
		this.intervalId = null;
	}

	getRenderCacheKey(): number {
		return this.renderRevision;
	}

	invalidate(): void {
		this.renderRevision += 1;
		this.cachedWidth = null;
		this.cachedFrameIndex = null;
		this.cachedElapsedSeconds = null;
		this.cachedLines = [];
	}

	updateStatus(status: TurnActivityStatus, startedAtMs = this.startedAtMs): void {
		if (
			this.startedAtMs === startedAtMs
			&& this.status.text === status.text
			&& this.status.kind === status.kind
			&& this.status.detail === status.detail
			&& this.status.retryAt === status.retryAt
		) {
			return;
		}
		this.status = status;
		this.startedAtMs = startedAtMs;
		this.invalidate();
	}

	render(width: number): string[] {
		const frame = this.frames[this.frameIndex] ?? this.frames[0] ?? "";
		const elapsedSeconds = elapsedSecondsFor(this.now() - this.startedAtMs);
		if (
			width === this.cachedWidth &&
			this.frameIndex === this.cachedFrameIndex &&
			elapsedSeconds === this.cachedElapsedSeconds
		) {
			return this.cachedLines;
		}
		const glyphs = uiGlyphs();
		const contentWidth = Math.max(1, width - TRANSCRIPT_HEADER_INDENT * 2);
		const title = theme.fg("text", this.headerText());
		const hint = theme.fg("muted", `(${formatElapsedCompact(elapsedSeconds)} ${glyphs.bullet} ${keyForAction("app.interrupt")} to interrupt)`);
		const header = new Text(
			truncateToWidth(
				`${theme.fg("accent", frame)} ${title} ${hint}`,
				contentWidth,
				glyphs.ellipsis,
			),
			TRANSCRIPT_HEADER_INDENT,
			0,
		).render(width);
		const detail = this.detailText();
		const lines = detail
			? [...header, ...new Text(theme.fg("dim", `  ${glyphs.branch} ${detail}`), TRANSCRIPT_HEADER_INDENT, 0).render(width).slice(0, 2)]
			: header;
		this.cachedWidth = width;
		this.cachedFrameIndex = this.frameIndex;
		this.cachedElapsedSeconds = elapsedSeconds;
		this.cachedLines = ["", ...lines, ""];
		return this.cachedLines;
	}

	private detailText(): string | null {
		const statusText = this.status.text.trim();
		const detail = this.status.detail?.trim();
		if (!detail || detail === statusText || detail === this.headerText()) return null;
		return detail;
	}

	private headerText(): string {
		return turnActivityHeaderText({
			text: this.status.text,
			kind: this.status.kind,
			variantKey: String(this.startedAtMs),
			retryAt: this.status.retryAt,
			nowMs: this.now(),
		});
	}

	private start(): void {
		if (this.intervalId) {
			return;
		}
		this.intervalId = setInterval(() => {
			if (this.animated) this.frameIndex = (this.frameIndex + 1) % this.frames.length;
			this.renderRevision += 1;
			this.ui.requestRender();
		}, this.animated ? 100 : 1_000);
		this.intervalId.unref?.();
	}
}
