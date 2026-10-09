import { Markdown } from "../../tui-core/components/markdown.ts";
import { Container, type TailRenderResult } from "../../tui-core/tui.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { markdownTheme } from "../shared/markdown-theme.ts";
import { formatKeyText, keyForAction } from "../shared/keybinding-hints.ts";
import { theme } from "../../theme/theme.ts";
import {
	renderTranscriptMessageLines,
	transcriptMessageContentWidth,
} from "./transcript-message-layout.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function reasoningPreviewLine(text: string): string {
	return text
		.split(/\r?\n/)
		.map((part) => part.trim().replace(/^#+\s*/, ""))
		.find((part) => part.length > 0) ?? "";
}

export class AssistantMessageComponent extends Container {
	private text: string;
	private thinking?: string;
	private thinkingHidden: boolean;
	private textMarkdown?: Markdown;
	private thinkingMarkdown?: Markdown;
	private thinkingPreview?: string;

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

	setThinkingHidden(thinkingHidden: boolean): void {
		if (this.thinkingHidden === thinkingHidden) return;
		this.thinkingHidden = thinkingHidden;
		this.rebuild();
	}

	private rebuild(): void {
		this.textMarkdown = undefined;
		this.thinkingMarkdown = undefined;
		const thinking = this.visibleThinking();
		this.thinkingPreview = thinking && this.thinkingHidden ? reasoningPreviewLine(thinking) : undefined;
		const text = this.visibleText();
		if (thinking) {
			this.thinkingMarkdown = new Markdown(thinking, 0, 0, markdownTheme(), {
				color: (content) => theme.fg("thinkingText", content),
				italic: true,
			});
		}
		if (text) {
			this.textMarkdown = new Markdown(text, 0, 0, markdownTheme());
		}
		this.markRenderDirty();
	}

	private visibleText(): string {
		return this.text.trim();
	}

	private visibleThinking(): string {
		const text = this.thinking?.trim() ?? "";
		if (!text) return "";
		if (!this.thinkingHidden) return text;
		const firstLine = reasoningPreviewLine(text);
		if (!firstLine) return "";
		return `${firstLine} ${uiGlyphs().ellipsis} + show detail (${formatKeyText(keyForAction("app.tools.expand"))})`;
	}

	/** True when the given rendered row is the collapsed reasoning preview line. */
	isDetailsToggleRow(row: number, width: number): boolean {
		if (!this.thinkingPreview || !this.thinkingMarkdown || row < 1) return false;
		// render() emits a leading blank row, so the collapsed preview occupies the
		// first rendered rows of the body. Match structurally: the rendered line may
		// differ from the raw markdown (bold, headings, wrapping).
		const contentWidth = transcriptMessageContentWidth(Math.max(1, Math.floor(width)));
		const previewRows = this.thinkingMarkdown.render(contentWidth).length;
		return row <= previewRows;
	}

	holdsNativeScrollbackTail(): boolean {
		return (this.textMarkdown ?? this.thinkingMarkdown)?.holdsStreamingTableTail() ?? false;
	}

	private bulletPrefix(): string {
		return theme.fg("text", `${uiGlyphs().bullet} `);
	}

	private bodyParts(): Array<Markdown | "separator"> {
		const parts: Array<Markdown | "separator"> = [];
		if (this.thinkingMarkdown) parts.push(this.thinkingMarkdown);
		if (this.thinkingMarkdown && this.textMarkdown) parts.push("separator");
		if (this.textMarkdown) parts.push(this.textMarkdown);
		return parts;
	}

	private bodyLines(contentWidth: number, safeWidth: number): string[] {
		const lines: string[] = [];
		for (const part of this.bodyParts()) {
			if (part === "separator") {
				lines.push(" ".repeat(safeWidth));
				continue;
			}
			lines.push(...renderTranscriptMessageLines(part.render(contentWidth), safeWidth, this.bulletPrefix()));
		}
		return lines;
	}

	renderTail(width: number, maxRows: number): TailRenderResult {
		const safeWidth = Math.max(1, Math.floor(width));
		const rowLimit = Math.max(0, Math.floor(maxRows));
		const content = this.renderContentTail(transcriptMessageContentWidth(safeWidth), safeWidth, rowLimit);
		const totalLines = content.totalLines > 0 ? content.totalLines + 1 : 0;
		if (rowLimit === 0 || totalLines === 0) return { lines: [], totalLines };

		const includesLeadingBlank = totalLines <= rowLimit;
		const lines = [...content.lines];
		if (includesLeadingBlank) lines.unshift(" ".repeat(safeWidth));
		if (includesLeadingBlank) lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return { lines: lines.slice(-rowLimit), totalLines };
	}

	private renderContentTail(width: number, safeWidth: number, maxRows: number): TailRenderResult {
		let remaining = maxRows;
		let totalLines = 0;
		const chunks: string[][] = [];
		const parts = this.bodyParts();
		for (let index = parts.length - 1; index >= 0; index -= 1) {
			const part = parts[index]!;
			if (part === "separator") {
				totalLines += 1;
				if (remaining > 0) {
					chunks.unshift([" ".repeat(safeWidth)]);
					remaining -= 1;
				}
				continue;
			}
			const rendered = part.renderTail(width, remaining);
			totalLines += rendered.totalLines;
			if (remaining > 0 && rendered.lines.length > 0) {
				const topShown = rendered.lines.length === rendered.totalLines;
				chunks.unshift(renderTranscriptMessageLines(
					rendered.lines,
					safeWidth,
					topShown ? this.bulletPrefix() : "  ",
				));
				remaining -= rendered.lines.length;
			}
		}
		return { lines: chunks.flat(), totalLines };
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const body = this.bodyLines(transcriptMessageContentWidth(safeWidth), safeWidth);
		const lines = body.length === 0 ? [] : [" ".repeat(safeWidth), ...body];
		if (lines.length === 0) {
			return lines;
		}
		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
