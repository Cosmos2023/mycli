import type { Component } from "../../tui-core/tui.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme } from "../../theme/theme.ts";

export class TranscriptSeparatorComponent implements Component {
	invalidate(): void {}

	getRenderCacheKey(): number {
		return 0;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(0, Math.floor(width));
		return safeWidth === 0 ? [] : ["", theme.fg("dim", uiGlyphs().horizontal.repeat(safeWidth))];
	}
}
