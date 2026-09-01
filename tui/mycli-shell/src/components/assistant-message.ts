import { Markdown } from "../tui-core/components/markdown.ts";
import { Spacer } from "../tui-core/components/spacer.ts";
import { Container, type TailRenderResult } from "../tui-core/tui.ts";
import { uiGlyphs } from "../theme/terminal-style.ts";
import { markdownTheme } from "./markdown-theme.ts";
import { theme } from "../theme/theme.ts";
import {
	renderTranscriptMessageLines,
	transcriptMessageContentWidth,
} from "./transcript-message-layout.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export class AssistantMessageComponent extends Container {
	private text: string;
	private thinking?: string;
	private thinkingHidden: boolean;
	private textMarkdown?: Markdown;
	private thinkingMarkdown?: Markdown;

	constructor(text: string, thinking?: string, thinkingHidden = true) {
		super();
		this.text = text;
		this.thinking = thinking;
		this.thinkingHidden = thinkingHidden;
		this.rebuild();
	}

	updateMessage(text: string, thinking?: string, thinkingHidden = true): void {
		const previousText = this.visibleText();
		const previousThinking = this.visibleThinking();
		this.text = text;
		this.thinking = thinking;
		this.thinkingHidden = thinkingHidden;
		const nextText = this.visibleText();
		const nextThinking = this.visibleThinking();
		if (Boolean(previousText) !== Boolean(nextText) || Boolean(previousThinking) !== Boolean(nextThinking)) {
			this.rebuild();
			return;
		}
		if (nextText !== previousText) this.textMarkdown?.setText(nextText);
		if (nextThinking !== previousThinking) this.thinkingMarkdown?.setText(nextThinking);
		if (nextText !== previousText || nextThinking !== previousThinking) {
			this.markRenderDirty();
		}
	}

	private rebuild(): void {
		this.clear();
		this.textMarkdown = undefined;
		this.thinkingMarkdown = undefined;
		const thinking = this.visibleThinking();
		const text = this.visibleText();
		if (thinking) {
			this.thinkingMarkdown = new Markdown(thinking, 0, 0, markdownTheme(), {
				color: (content) => theme.fg("thinkingText", content),
				italic: true,
			});
			this.addChild(this.thinkingMarkdown);
			if (text) this.addChild(new Spacer(1));
		}
		if (text) {
			this.textMarkdown = new Markdown(text, 0, 0, markdownTheme());
			this.addChild(this.textMarkdown);
		}
	}

	private visibleText(): string {
		return this.text.trim();
	}

	private visibleThinking(): string {
		return this.thinkingHidden ? "" : (this.thinking?.trim() ?? "");
	}

	holdsNativeScrollbackTail(): boolean {
		return (this.textMarkdown ?? this.thinkingMarkdown)?.holdsStreamingTableTail() ?? false;
	}

	renderTail(width: number, maxRows: number): TailRenderResult {
		const safeWidth = Math.max(1, Math.floor(width));
		const rowLimit = Math.max(0, Math.floor(maxRows));
		const content = this.renderContentTail(transcriptMessageContentWidth(safeWidth), rowLimit);
		const totalLines = content.totalLines > 0 ? content.totalLines + 1 : 0;
		if (rowLimit === 0 || totalLines === 0) return { lines: [], totalLines };

		const includesLeadingBlank = totalLines <= rowLimit;
		const contentTruncated = content.totalLines > content.lines.length;
		const lines = renderTranscriptMessageLines(
			content.lines,
			safeWidth,
			contentTruncated ? "  " : theme.fg("text", `${uiGlyphs().bullet} `),
		);
		if (includesLeadingBlank) lines.unshift(" ".repeat(safeWidth));
		if (includesLeadingBlank) lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return { lines: lines.slice(-rowLimit), totalLines };
	}

	private renderContentTail(width: number, maxRows: number): TailRenderResult {
		const sections: Array<Markdown | string[]> = [];
		if (this.thinkingMarkdown) sections.push(this.thinkingMarkdown);
		if (this.thinkingMarkdown && this.textMarkdown) sections.push([""]);
		if (this.textMarkdown) sections.push(this.textMarkdown);

		let remaining = maxRows;
		let totalLines = 0;
		const lines: string[] = [];
		for (let index = sections.length - 1; index >= 0; index -= 1) {
			const section = sections[index]!;
			const rendered = section instanceof Markdown
				? section.renderTail(width, remaining)
				: { lines: remaining > 0 ? section.slice(-remaining) : [], totalLines: section.length };
			totalLines += rendered.totalLines;
			if (remaining > 0) {
				lines.unshift(...rendered.lines);
				remaining -= rendered.lines.length;
			}
		}
		return { lines, totalLines };
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const content = super.render(transcriptMessageContentWidth(safeWidth));
		const lines = content.length === 0
			? []
			: [
				" ".repeat(safeWidth),
				...renderTranscriptMessageLines(content, safeWidth, theme.fg("text", `${uiGlyphs().bullet} `)),
			];
		if (lines.length === 0) {
			return lines;
		}
		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
