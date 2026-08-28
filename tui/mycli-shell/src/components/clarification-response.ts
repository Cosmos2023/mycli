import type { MycliShellClarificationResponse } from "../model.ts";
import type { Component } from "../tui-core/tui.ts";
import { truncateToWidth, wrapTextWithAnsi } from "../tui-core/utils.ts";
import { theme } from "../theme/theme.ts";

export class ClarificationResponseComponent implements Component {
	constructor(private readonly clarification: MycliShellClarificationResponse) {}

	invalidate(): void {}

	getRenderCacheKey(): number {
		return 0;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const title = this.clarification.header?.trim() || "Question";
		const lines = ["", this.fit(theme.fg("accent", theme.bold(`• ${title}`)), safeWidth)];
		this.pushWrapped(lines, this.clarification.question, "  ", "text", safeWidth);
		this.pushWrapped(lines, this.clarification.response, "  → ", "success", safeWidth);
		return lines;
	}

	private pushWrapped(
		lines: string[],
		value: string,
		prefix: string,
		color: "text" | "success",
		width: number,
	): void {
		const text = value.replace(/[\r\n\t]+/g, " ").trim();
		const continuation = " ".repeat(prefix.length);
		const wrapped = wrapTextWithAnsi(text, Math.max(1, width - prefix.length));
		for (const [index, line] of wrapped.entries()) {
			const linePrefix = index === 0 ? prefix : continuation;
			lines.push(this.fit(`${theme.fg(index === 0 && prefix.includes("→") ? "accent" : color, linePrefix)}${theme.fg(color, line)}`, width));
		}
	}

	private fit(text: string, width: number): string {
		return truncateToWidth(text, width, "");
	}
}
