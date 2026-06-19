import { Spacer } from "../tui-core/components/spacer.ts";
import { Text } from "../tui-core/components/text.ts";
import { Container } from "../tui-core/tui.ts";
import type { MycliShellTool } from "../model.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import { conciseToolResult, firstMeaningfulLine, presentationForTool } from "./tool-presentation.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

function formatDuration(ms: number | undefined): string | undefined {
	if (ms === undefined) return undefined;
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
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
		const presentation = presentationForTool(this.tool.name, this.tool.status, this.tool.mutating);
		const duration = formatDuration(this.tool.durationMs);
		const suffix = duration ? theme.fg("dim", ` ${duration}`) : "";
		return `${theme.fg(presentation.accent, theme.bold(presentation.icon))} ${theme.fg(presentation.accent, theme.bold(presentation.label))}${suffix}`;
	}

	private resultText(): string {
		const color = this.tool.status === "error" ? "error" : "muted";
		return theme.fg(color, `⎿ ${this.resultSummary()}`);
	}

	private resultSummary(): string {
		return conciseToolResult(this.tool);
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
		if (this.tool.diffPreview) {
			return this.tool.diffPreview;
		}
		if (this.tool.contentPreview) {
			return this.tool.contentPreview;
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
		if (this.tool.diffPreview) {
			return styleDiff(text);
		}
		return theme.fg("muted", text);
	}

	private previewLineLimit(): number {
		const presentation = presentationForTool(this.tool.name, this.tool.status, this.tool.mutating);
		return this.tool.contentPreview ? presentation.writePreviewLines : presentation.previewLines;
	}

	private hiddenLineCount(): number {
		if (this.tool.contentPreview && this.tool.contentLineCount !== undefined) {
			const presentation = presentationForTool(this.tool.name, this.tool.status, this.tool.mutating);
			return Math.max(0, this.tool.contentLineCount - presentation.writePreviewLines);
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
		const presentation = presentationForTool(this.tool.name, this.tool.status, this.tool.mutating);
		if (visualLines.length <= presentation.writePreviewLines) {
			return { visualLines, skippedCount: 0 };
		}
		return {
			visualLines: visualLines.slice(0, presentation.writePreviewLines),
			skippedCount: visualLines.length - presentation.writePreviewLines,
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
