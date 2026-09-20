import { Text } from "../../tui-core/components/text.ts";
import type { Component } from "../../tui-core/tui.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme } from "../../theme/theme.ts";
import { TRANSCRIPT_HEADER_INDENT } from "./transcript-gutter.ts";

/**
 * Transcript cell for an approval decision ("You approved mycli to run …").
 *
 * Other transcript cells open with a blank line so neighbouring blocks keep a
 * consistent gap; a bare system notice does not, which made the decision line
 * sit tight against the message above it.
 */
export class ApprovalDecisionComponent implements Component {
	constructor(private readonly text: string, private readonly rejected: boolean) {}

	invalidate(): void {}

	render(width: number): string[] {
		const safeWidth = Math.max(0, width);
		if (safeWidth === 0) return [];
		const glyphs = uiGlyphs();
		const glyph = this.rejected ? glyphs.warning : glyphs.success;
		const color = this.rejected ? "warning" : "success";
		return [
			"",
			...new Text(theme.fg(color, `${glyph} ${this.text}`), TRANSCRIPT_HEADER_INDENT, 0).render(safeWidth),
		];
	}
}
