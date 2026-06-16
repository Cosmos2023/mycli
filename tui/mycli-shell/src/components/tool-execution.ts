import { Spacer } from "../tui-core/components/spacer.ts";
import { Text } from "../tui-core/components/text.ts";
import { Container } from "../tui-core/tui.ts";
import type { MycliShellTool } from "../model.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import { canonicalToolName, shortPreview } from "./tool-display.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

const PREVIEW_LINES = 12;
const WRITE_PREVIEW_LINES = 10;

function formatDuration(ms: number | undefined): string | undefined {
	if (ms === undefined) return undefined;
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function firstMeaningfulLine(text: string | undefined): string | undefined {
	return text
		?.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
}

function singleLineText(text: string | undefined): boolean {
	const trimmed = text?.trim();
	return trimmed ? trimmed.split("\n").length === 1 : false;
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
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.headerText(), 1, 0));
		this.addChild(new Text(this.resultText(), 3, 0));
		const details = this.detailsComponent();
		if (details) {
			this.addChild(details);
		}
	}

	private headerText(): string {
		const nameColor = this.tool.status === "error" ? "error" : this.tool.mutating ? "warning" : "accent";
		const duration = formatDuration(this.tool.durationMs);
		const suffix = duration ? theme.fg("dim", ` ${duration}`) : "";
		return `${theme.fg(nameColor, theme.bold("⏺"))} ${theme.fg(nameColor, theme.bold(canonicalToolName(this.tool.name)))}${suffix}`;
	}

	private resultText(): string {
		const color = this.tool.status === "error" ? "error" : "muted";
		return theme.fg(color, `⎿ ${this.resultSummary()}`);
	}

	private resultSummary(): string {
		const target = shortPreview(this.tool.args);
		if (this.tool.status === "running") {
			return target ? `${target} · Running...` : "Running...";
		}
		if (this.tool.status === "cancelled") {
			return target ? `${target} · Cancelled` : "Cancelled";
		}
		if (this.tool.status === "error") {
			const failure = firstMeaningfulLine(this.tool.errorPreview ?? this.tool.outputPreview) ?? "Failed";
			return target ? `${target} · ${failure}` : failure;
		}
		if (this.tool.contentPreview) {
			const lineCount = this.tool.contentLineCount;
			const summary = lineCount !== undefined ? `Wrote ${lineCount} ${lineCount === 1 ? "line" : "lines"}` : "Wrote file";
			return target ? `${target} · ${summary}` : summary;
		}
		if (this.tool.diffPreview) {
			const summary = target ? `Updated ${target}` : "Updated file";
			return summary;
		}
		const summary = firstMeaningfulLine(this.tool.outputPreview) ?? this.statusLabel();
		if (target && summary !== target) {
			return `${target} · ${summary}`;
		}
		return summary;
	}

	private detailsComponent(): Text | { render: (width: number) => string[]; invalidate: () => void } | undefined {
		const fullText = this.detailText();
		if (!fullText) {
			return undefined;
		}
		if (this.tool.expanded) {
			return new Text(this.styleDetailText(fullText), 5, 0);
		}
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;
		return {
			render: (width: number) => {
				if (cachedWidth !== width || !cachedLines) {
					const result = this.truncateDetailText(fullText, width);
					const hiddenCount = Math.max(this.hiddenLineCount(), result.skippedCount);
					cachedLines = result.visualLines;
					if (hiddenCount > 0) {
						cachedLines = [
							...cachedLines,
							...new Text(theme.fg("muted", this.hiddenLinesText(hiddenCount)), 5, 0).render(width),
						];
					} else if (this.shouldShowCollapsedHint()) {
						cachedLines = [...cachedLines, ...new Text(this.collapsedHint(), 5, 0).render(width)];
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
		if (this.tool.contentPreview) {
			return this.tool.contentPreview;
		}
		if (this.tool.diffPreview) {
			return this.tool.diffPreview;
		}
		if (!this.tool.expanded && !this.tool.hiddenLineCount && singleLineText(this.tool.outputPreview)) {
			return "";
		}
		return this.tool.outputPreview ?? "";
	}

	private styleDetailText(text: string): string {
		if (this.tool.status === "error") {
			return theme.fg("error", text);
		}
		if (this.tool.diffPreview && !this.tool.contentPreview) {
			return styleDiff(text);
		}
		return theme.fg("muted", text);
	}

	private previewLineLimit(): number {
		return this.tool.contentPreview ? WRITE_PREVIEW_LINES : PREVIEW_LINES;
	}

	private hiddenLineCount(): number {
		if (this.tool.contentPreview && this.tool.contentLineCount !== undefined) {
			return Math.max(0, this.tool.contentLineCount - WRITE_PREVIEW_LINES);
		}
		return this.tool.hiddenLineCount ?? 0;
	}

	private hiddenLinesText(hiddenCount: number): string {
		if (this.tool.contentPreview && this.tool.contentLineCount !== undefined) {
			return `... (${hiddenCount} more lines, ${this.tool.contentLineCount} total, ${keyHint("app.tools.expand", "to expand")})`;
		}
		return `... ${hiddenCount} more lines (${keyHint("app.tools.expand", "to expand")})`;
	}

	private truncateDetailText(text: string, width: number): { visualLines: string[]; skippedCount: number } {
		const styled = this.styleDetailText(text);
		if (!this.tool.contentPreview) {
			return truncateToVisualLines(styled, this.previewLineLimit(), width, 5);
		}
		const visualLines = new Text(styled, 5, 0).render(width);
		if (visualLines.length <= WRITE_PREVIEW_LINES) {
			return { visualLines, skippedCount: 0 };
		}
		return {
			visualLines: visualLines.slice(0, WRITE_PREVIEW_LINES),
			skippedCount: visualLines.length - WRITE_PREVIEW_LINES,
		};
	}

	private collapsedHint(): string {
		const reason = this.tool.status === "running" ? "waiting" : this.tool.status === "error" ? "failed" : "details hidden";
		return theme.fg("muted", `${reason}${this.shouldShowCollapsedHint() ? ` (${keyHint("app.tools.expand", "expand")})` : ""}`);
	}

	private shouldShowCollapsedHint(): boolean {
		return (
			!this.tool.expanded &&
			Boolean(this.tool.hiddenLineCount || this.tool.outputPreview || this.tool.errorPreview || this.tool.diffPreview || this.tool.contentPreview)
		);
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

function styleDiff(text: string): string {
	return text
		.split("\n")
		.map((line) => {
			if (line.startsWith("+") && !line.startsWith("+++")) {
				return theme.fg("toolDiffAdded", line);
			}
			if (line.startsWith("-") && !line.startsWith("---")) {
				return theme.fg("toolDiffRemoved", line);
			}
			if (line.startsWith("@@")) {
				return theme.fg("accent", line);
			}
			return theme.fg("toolDiffContext", line);
		})
		.join("\n");
}
