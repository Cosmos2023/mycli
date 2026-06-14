import { Box } from "../tui-core/components/box.ts";
import { Spacer } from "../tui-core/components/spacer.ts";
import { Text } from "../tui-core/components/text.ts";
import { Container } from "../tui-core/tui.ts";
import type { MycliShellTool } from "../model.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

const PREVIEW_LINES = 12;

function sanitizeInline(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatDuration(ms: number | undefined): string | undefined {
	if (ms === undefined) return undefined;
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

export class ToolExecutionComponent extends Container {
	private tool: MycliShellTool;

	constructor(tool: MycliShellTool) {
		super();
		this.tool = tool;
		this.rebuild();
	}

	updateTool(tool: MycliShellTool): void {
		this.tool = tool;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		if (this.tool.hidden) {
			return;
		}
		const bg = this.tool.status === "error" ? "toolErrorBg" : this.tool.status === "success" ? "toolSuccessBg" : "toolPendingBg";
		const box = new Box(1, 1, (content: string) => theme.bg(bg, content));
		box.addChild(new Text(this.headerText(), 0, 0));
		box.addChild(this.detailsComponent());
		this.addChild(new Spacer(1));
		this.addChild(box);
	}

	private headerText(): string {
		const status = this.statusLabel();
		const nameColor = this.tool.status === "error" ? "error" : this.tool.mutating ? "warning" : "accent";
		const parts = [
			theme.fg(nameColor, theme.bold(this.tool.name)),
			this.tool.args ? theme.fg("muted", sanitizeInline(this.tool.args)) : undefined,
			theme.fg("muted", `(${status})`),
			formatDuration(this.tool.durationMs) ? theme.fg("dim", formatDuration(this.tool.durationMs)!) : undefined,
		].filter(Boolean);
		return parts.join(" ");
	}

	private detailsComponent(): Text | { render: (width: number) => string[]; invalidate: () => void } {
		const fullText = this.detailText();
		if (!fullText) {
			return new Text(this.collapsedHint(), 0, 0);
		}
		if (this.tool.expanded) {
			return new Text(theme.fg(this.tool.status === "error" ? "error" : "muted", fullText), 0, 0);
		}
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		return {
			render: (width: number) => {
				if (cachedWidth !== width || !cachedLines) {
					const styled = theme.fg(this.tool.status === "error" ? "error" : "muted", fullText);
					const result = truncateToVisualLines(styled, PREVIEW_LINES, width, 0);
					const hiddenCount = Math.max(this.tool.hiddenLineCount ?? 0, result.skippedCount);
					cachedLines = result.visualLines;
					if (hiddenCount > 0) {
						cachedLines = [
							...cachedLines,
							theme.fg("muted", `... ${hiddenCount} more lines (${keyHint("app.tools.expand", "to expand")})`),
						];
					} else if (this.shouldShowCollapsedHint()) {
						cachedLines = [...cachedLines, this.collapsedHint()];
					}
					cachedWidth = width;
				}
				return cachedLines;
			},
			invalidate: () => {
				cachedWidth = undefined;
				cachedLines = undefined;
			},
		};
	}

	private detailText(): string {
		if (this.tool.status === "error") {
			return this.tool.errorPreview ?? this.tool.outputPreview ?? "";
		}
		if (this.tool.diffPreview) {
			return this.tool.diffPreview;
		}
		return this.tool.outputPreview ?? "";
	}

	private collapsedHint(): string {
		const reason = this.tool.status === "running" ? "waiting" : this.tool.status === "error" ? "failed" : "details hidden";
		return theme.fg("muted", `${reason}${this.shouldShowCollapsedHint() ? ` (${keyHint("app.tools.expand", "expand")})` : ""}`);
	}

	private shouldShowCollapsedHint(): boolean {
		return !this.tool.expanded && Boolean(this.tool.hiddenLineCount || this.tool.outputPreview || this.tool.errorPreview || this.tool.diffPreview);
	}

	private statusLabel(): string {
		switch (this.tool.status) {
			case "running":
				return "running";
			case "success":
				return this.tool.mutating ? "changed" : "done";
			case "error":
				return "failed";
			case "cancelled":
				return "cancelled";
		}
	}
}
