import type { Component } from "../../tui-core/tui.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme } from "../../theme/theme.ts";

export class DynamicBorder implements Component {
	constructor(private readonly color: (text: string) => string = (text) => theme.fg("border", text)) {}

	invalidate(): void {}

	render(width: number): string[] {
		return [this.color(uiGlyphs().horizontal.repeat(Math.max(1, width)))];
	}
}
