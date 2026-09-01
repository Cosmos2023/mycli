import type { Component } from "../tui-core/tui.ts";
import { truncateToWidth, wrapTextWithAnsi } from "../tui-core/utils.ts";
import type { MycliShellPlanStepStatus, MycliShellPlanUpdate } from "../model.ts";
import { uiGlyphs } from "../theme/terminal-style.ts";
import { theme } from "../theme/theme.ts";

export class PlanUpdateComponent implements Component {
	constructor(private readonly update: MycliShellPlanUpdate) {}

	invalidate(): void {}

	getRenderCacheKey(): number {
		return 0;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const title = this.update.title.trim() || "Updated Plan";
		const lines = ["", this.fit(theme.fg("accent", theme.bold(`${uiGlyphs().bullet} ${title}`)), safeWidth)];
		const explanation = this.update.explanation?.replace(/[\r\n\t]+/g, " ").trim();
		if (explanation) {
			for (const line of wrapTextWithAnsi(explanation, Math.max(1, safeWidth - 2))) {
				lines.push(this.fit(theme.fg("muted", `  ${line}`), safeWidth));
			}
		}
		if (this.update.steps.length === 0) {
			lines.push(this.fit(theme.fg("muted", "  (no steps provided)"), safeWidth));
			return lines;
		}
		for (const step of this.update.steps) {
			const marker = step.status === "completed" ? uiGlyphs().completed : uiGlyphs().pending;
			const text = step.text.replace(/[\r\n\t]+/g, " ").trim();
			const wrapped = wrapTextWithAnsi(text, Math.max(1, safeWidth - 4));
			for (const [index, line] of wrapped.entries()) {
				const prefix = index === 0 ? `  ${marker} ` : "    ";
				lines.push(
					this.fit(
						`${this.styleMarker(step.status, prefix)}${this.styleText(step.status, line)}`,
						safeWidth,
					),
				);
			}
		}
		return lines;
	}

	private styleMarker(status: MycliShellPlanStepStatus, marker: string): string {
		return theme.fg(status === "in_progress" ? "accent" : "muted", marker);
	}

	private styleText(status: MycliShellPlanStepStatus, text: string): string {
		if (status === "completed") {
			return theme.fg("muted", theme.strikethrough(text));
		}
		if (status === "in_progress") {
			return theme.fg("text", theme.bold(text));
		}
		return theme.fg("muted", text);
	}

	private fit(text: string, width: number): string {
		return truncateToWidth(text, width, "");
	}
}
