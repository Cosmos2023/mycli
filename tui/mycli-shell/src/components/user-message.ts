import { Markdown } from "../tui-core/components/markdown.ts";
import { Container } from "../tui-core/tui.ts";
import { uiGlyphs } from "../theme/terminal-style.ts";
import { markdownTheme } from "./markdown-theme.ts";
import { theme } from "../theme/theme.ts";
import { applyBackgroundToLine } from "../tui-core/utils.ts";
import {
	renderTranscriptMessageLines,
	transcriptMessageContentWidth,
} from "./transcript-message-layout.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export class UserMessageComponent extends Container {
	constructor(text: string) {
		super();
		this.addChild(
			new Markdown(
				text,
				0,
				0,
				markdownTheme(),
				{ color: (content: string) => theme.fg("userMessageText", content) },
				{ preserveOrderedListMarkers: true },
			),
		);
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const content = super.render(transcriptMessageContentWidth(safeWidth));
		const rawLines = content.length === 0
			? []
			: [
				" ".repeat(safeWidth),
				...renderTranscriptMessageLines(content, safeWidth, theme.fg("accent", `${uiGlyphs().selector} `)),
				" ".repeat(safeWidth),
			];
		const backgroundLines = rawLines.map((line) =>
			applyBackgroundToLine(
				line,
				safeWidth,
				(value) => theme.bg("userMessageBg", value),
			),
		);
		const lines = backgroundLines.length === 0
			? []
			: [" ".repeat(safeWidth), ...backgroundLines];
		if (lines.length === 0) {
			return lines;
		}
		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
