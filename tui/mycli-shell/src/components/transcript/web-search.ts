import type { MycliShellWebSearch } from "../../model.ts";
import type { Component } from "../../tui-core/tui.ts";
import { truncateToWidth } from "../../tui-core/utils.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme } from "../../theme/theme.ts";

export class WebSearchComponent implements Component {
	constructor(private readonly search: MycliShellWebSearch) {}

	invalidate(): void {}

	getRenderCacheKey(): number {
		return 0;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const completed = this.search.status === "completed";
		const marker = completed ? uiGlyphs().bullet : uiGlyphs().spinnerFrames[0];
		const title = completed ? "Searched the web" : "Searching the web";
		const separator = completed ? " for " : " ";
		const detail = this.search.detail?.trim();
		const text = detail ? `${title}${separator}${detail}` : title;
		return [
			"",
			truncateToWidth(
				`${theme.fg(completed ? "muted" : "accent", marker)} ${theme.bold(text)}`,
				safeWidth,
				"",
			),
		];
	}
}
