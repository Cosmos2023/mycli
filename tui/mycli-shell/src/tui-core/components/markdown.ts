import { Lexer, Marked, type Token, Tokenizer, type Tokens } from "marked";
import { getCapabilities, hyperlink, isImageLine } from "../terminal-image.ts";
import type { Component, TailRenderResult } from "../tui.ts";
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.ts";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;
const TABLE_DELIMITER_LINE_REGEX = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/mu;
const ANSI_FULL_RESET = "\x1b[0m";

class StrictStrikethroughTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2];
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

const markdownParser = new Marked();
markdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
	/** Foreground color function */
	color?: (text: string) => string;
	/** Background color function */
	bgColor?: (text: string) => string;
	/** Bold text */
	bold?: boolean;
	/** Italic text */
	italic?: boolean;
	/** Strikethrough text */
	strikethrough?: boolean;
	/** Underline text */
	underline?: boolean;
}

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	readonly glyphs?: {
		readonly vertical: string;
		readonly horizontal: string;
		readonly teeLeft: string;
		readonly teeRight: string;
		readonly teeTop: string;
		readonly teeBottom: string;
		readonly cross: string;
		readonly tableTopLeft: string;
		readonly tableTopRight: string;
		readonly tableBottomLeft: string;
		readonly tableBottomRight: string;
	};
	highlightCode?: (code: string, lang?: string) => string[];
	/** Prefix applied to each rendered code block line (default: "  ") */
	codeBlockIndent?: string;
}

export interface MarkdownOptions {
	/** Preserve source ordered-list markers instead of normalizing them from the list start. */
	preserveOrderedListMarkers?: boolean;
	/** Maximum rendered lines for fenced code blocks. Undefined renders full code blocks. */
	codeBlockPreviewLines?: number;
}

interface MarkdownTableGlyphs {
	readonly horizontal: string;
	readonly teeLeft: string;
	readonly teeRight: string;
	readonly teeTop: string;
	readonly teeBottom: string;
	readonly cross: string;
	readonly topLeft: string;
	readonly topRight: string;
	readonly bottomLeft: string;
	readonly bottomRight: string;
}

function markdownTableGlyphs(theme: MarkdownTheme): MarkdownTableGlyphs {
	return {
		horizontal: theme.glyphs?.horizontal ?? "─",
		teeLeft: theme.glyphs?.teeLeft ?? "├",
		teeRight: theme.glyphs?.teeRight ?? "┤",
		teeTop: theme.glyphs?.teeTop ?? "┬",
		teeBottom: theme.glyphs?.teeBottom ?? "┴",
		cross: theme.glyphs?.cross ?? "┼",
		topLeft: theme.glyphs?.tableTopLeft ?? "┌",
		topRight: theme.glyphs?.tableTopRight ?? "┐",
		bottomLeft: theme.glyphs?.tableBottomLeft ?? "└",
		bottomRight: theme.glyphs?.tableBottomRight ?? "┘",
	};
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

interface RenderedTokenCacheEntry {
	type: string;
	raw: string;
	contextKey?: string;
	nextType?: string;
	lines: string[];
	code?: RenderedCodeTokenCache;
	list?: RenderedFlatListTokenCache;
	paragraph?: RenderedPlainParagraphCache;
	richParagraph?: RenderedRichParagraphCache;
	blockquote?: RenderedPlainBlockquoteCache;
	table?: RenderedTableTokenCache;
}

interface RenderedCodeTokenCache {
	text: string;
	lang: string | undefined;
	openingLineCount: number;
	bodyLineEnds: number[];
	sourceToken: Tokens.Code;
}

interface RenderedPlainParagraphCache {
	text: string;
	lastSourceLineStart?: number;
	lastSourceLineOutputStart?: number;
	sourceToken: Tokens.Paragraph;
}

interface RenderedRichParagraphCache {
	stableInlineCount: number;
	stableOutputLineCount: number;
	stableTailSource: string;
	sourceToken: Tokens.Paragraph;
}

interface RenderedPlainBlockquoteCache {
	text: string;
	lastSourceLineStart: number;
	lastSourceLineOutputStart: number;
	sourceToken: Tokens.Blockquote;
}

interface RenderedFlatListTokenCache {
	itemLineEnds: number[];
	sourceToken: Tokens.List;
}

interface TableRowMetrics {
	naturalWidths: number[];
	minWordWidths: number[];
}

interface TableColumnLayout extends TableRowMetrics {
	columnWidths: number[];
}

interface RenderedTableLines {
	lines: string[];
	rowBoundaryStarts: number[];
	bottomLineStart: number;
}

interface RenderedTableTokenCache extends TableColumnLayout {
	rowBoundaryStarts: number[];
	bottomLineStart: number;
	finalRowMetrics: TableRowMetrics;
	sourceToken: Tokens.Table;
}

interface FlatListInfo {
	lastItemOffset: number;
	marker: string;
	ordered: boolean;
}

interface AppendedListUpdate {
	sourceToken: Tokens.List;
	stableItemCount: number;
}

interface StreamingTableInfo {
	headerSource: string;
	lastRowOffset: number;
}

interface StreamingInlineParagraphInfo {
	boundaryOffset: number;
	stableInlineCount: number;
}

interface AppendedInlineParagraphUpdate {
	sourceToken: Tokens.Paragraph;
	stableInlineCount: number;
}

interface OpenFenceInfo {
	bodyOffset: number;
	closingPattern: RegExp;
}

interface MarkdownTokenUpdate {
	tokens: Token[];
	stablePrefixLength: number;
	changed: boolean;
}

function normalizeMarkdownSource(source: string): string {
	return source.replace(/\t/g, "   ");
}

const MAX_INLINE_TAIL_BOUNDARY_TOKENS = 32;

export class Markdown implements Component {
	private text: string;
	private normalizedText: string;
	private hasReferenceSyntax: boolean;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private defaultTextStyle?: DefaultTextStyle;
	private theme: MarkdownTheme;
	private options: MarkdownOptions;
	private defaultStylePrefix?: string;

	// Cache for rendered output
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private cachedTokenWidth?: number;
	private cachedTokens: RenderedTokenCacheEntry[] = [];
	private cachedTokenLineCount = 0;
	private cachedLexedText?: string;
	private cachedSourceTokens: Token[] = [];
	private cachedSourceTokenEnds: number[] = [];
	private cachedOpenFences = new WeakMap<Token, OpenFenceInfo | null>();
	private cachedFlatLists = new WeakMap<Token, FlatListInfo | null>();
	private cachedStreamingTables = new WeakMap<Token, StreamingTableInfo | null>();
	private cachedStreamingInlineParagraphs = new WeakMap<Token, StreamingInlineParagraphInfo | null>();
	private appendedTokenSources = new WeakMap<Token, Token>();
	private appendedListUpdates = new WeakMap<Token, AppendedListUpdate>();
	private appendedInlineParagraphUpdates = new WeakMap<Token, AppendedInlineParagraphUpdate>();
	private normalizedTextExtendsLexedText = false;
	private pendingNormalizedAppend = "";

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
	) {
		this.text = text;
		this.normalizedText = normalizeMarkdownSource(text);
		this.hasReferenceSyntax = text.includes("[");
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
		this.defaultTextStyle = defaultTextStyle;
		this.options = options ? { ...options } : {};
	}

	setText(text: string): void {
		if (this.text === text) return;
		if (text.startsWith(this.text)) {
			const suffix = text.slice(this.text.length);
			const normalizedSuffix = normalizeMarkdownSource(suffix);
			this.normalizedText += normalizedSuffix;
			if (this.normalizedTextExtendsLexedText) {
				this.pendingNormalizedAppend += normalizedSuffix;
			}
			this.hasReferenceSyntax ||= suffix.includes("[");
		} else {
			this.normalizedText = normalizeMarkdownSource(text);
			this.hasReferenceSyntax = text.includes("[");
			this.normalizedTextExtendsLexedText = false;
			this.pendingNormalizedAppend = "";
		}
		this.text = text;
		this.cachedText = undefined;
		this.cachedLines = undefined;
	}

	holdsStreamingTableTail(): boolean {
		// Policy checks run before paint, so they must not consume updateSourceTokens().
		let tokens = this.cachedSourceTokens;
		if (this.cachedLexedText === undefined) {
			tokens = this.lexSource(this.normalizedText);
		} else if (this.cachedLexedText !== this.normalizedText) {
			const candidate = this.normalizedTextExtendsLexedText
				? this.cachedLexedText.slice(this.cachedLexedText.lastIndexOf("\n") + 1) + this.pendingNormalizedAppend
				: this.normalizedText;
			if (TABLE_DELIMITER_LINE_REGEX.test(candidate)) {
				tokens = this.lexSource(this.normalizedText);
			}
		}
		for (let index = tokens.length - 1; index >= 0; index -= 1) {
			const token = tokens[index]!;
			if (token.type === "space") continue;
			return token.type === "table";
		}
		return false;
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.cachedTokenWidth = undefined;
		this.cachedTokens = [];
		this.cachedTokenLineCount = 0;
		this.cachedLexedText = undefined;
		this.cachedSourceTokens = [];
		this.cachedSourceTokenEnds = [];
		this.cachedOpenFences = new WeakMap();
		this.cachedFlatLists = new WeakMap();
		this.cachedStreamingTables = new WeakMap();
		this.cachedStreamingInlineParagraphs = new WeakMap();
		this.appendedTokenSources = new WeakMap();
		this.appendedListUpdates = new WeakMap();
		this.appendedInlineParagraphUpdates = new WeakMap();
		this.normalizedTextExtendsLexedText = false;
		this.pendingNormalizedAppend = "";
	}

	render(width: number): string[] {
		// Check cache
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// Calculate available width for content (subtract horizontal padding)
		const contentWidth = Math.max(1, width - this.paddingX * 2);

		// Don't render anything if there's no actual text
		if (!this.text || this.text.trim() === "") {
			const result: string[] = [];
			// Update cache
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		const tokenLines = this.renderTokenLines(width, contentWidth);
		const contentLines: string[] = [];
		for (const entry of tokenLines) {
			contentLines.push(...entry.lines);
		}

		// Add top/bottom padding (empty lines)
		const bgFn = this.defaultTextStyle?.bgColor;
		const emptyLine = " ".repeat(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
			emptyLines.push(line);
		}

		// Combine top padding, content, and bottom padding
		const result = emptyLines.concat(contentLines, emptyLines);

		// Update cache
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}

	renderTail(width: number, maxRows: number): TailRenderResult {
		const rowLimit = Math.max(0, Math.floor(maxRows));
		if (!this.text || this.text.trim() === "") return { lines: [], totalLines: 0 };

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const tokenLines = this.renderTokenLines(width, contentWidth);
		const totalLines = this.paddingY * 2 + this.cachedTokenLineCount;
		if (totalLines === 0) {
			return { lines: rowLimit > 0 ? [""] : [], totalLines: 1 };
		}

		let remaining = rowLimit;
		const lines: string[] = [];
		const emptyLine = " ".repeat(width);
		const bgFn = this.defaultTextStyle?.bgColor;
		const paddingLine = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
		const prependTail = (source: string[]): void => {
			if (remaining <= 0 || source.length === 0) return;
			const selected = source.slice(-remaining);
			lines.unshift(...selected);
			remaining -= selected.length;
		};

		prependTail(Array.from({ length: this.paddingY }, () => paddingLine));
		for (let index = tokenLines.length - 1; index >= 0 && remaining > 0; index -= 1) {
			prependTail(tokenLines[index]!.lines);
		}
		prependTail(Array.from({ length: this.paddingY }, () => paddingLine));
		return { lines, totalLines };
	}

	private renderTokenLines(width: number, contentWidth: number): RenderedTokenCacheEntry[] {
		const tokenUpdate = this.updateSourceTokens();
		if (!tokenUpdate.changed && this.cachedTokenWidth === width) {
			return this.cachedTokens;
		}

		const previousTokens = this.cachedTokenWidth === width ? this.cachedTokens : [];
		const renderStart = previousTokens.length > 0
			? Math.max(0, Math.min(tokenUpdate.stablePrefixLength, previousTokens.length) - 1)
			: 0;
		const removedLineCount = previousTokens
			.slice(renderStart)
			.reduce((count, entry) => count + entry.lines.length, 0);
		const nextTokenCache: RenderedTokenCacheEntry[] = [];
		for (let index = renderStart; index < tokenUpdate.tokens.length; index += 1) {
			const token = tokenUpdate.tokens[index]!;
			const nextType = tokenUpdate.tokens[index + 1]?.type;
			const contextKey = token.type !== "code" && token.raw.includes("[")
				? JSON.stringify(token)
				: undefined;
			const cached = previousTokens[index];
			nextTokenCache.push(this.renderTokenCacheEntry(
				token,
				contentWidth,
				width,
				nextType,
				contextKey,
				cached,
			));
		}
		if (this.cachedTokenWidth === width) {
			this.cachedTokens.splice(
				renderStart,
				this.cachedTokens.length - renderStart,
				...nextTokenCache,
			);
		}
		const addedLineCount = nextTokenCache.reduce((count, entry) => count + entry.lines.length, 0);
		if (this.cachedTokenWidth === width) {
			this.cachedTokenLineCount += addedLineCount - removedLineCount;
		} else {
			this.cachedTokens = nextTokenCache;
			this.cachedTokenLineCount = addedLineCount;
		}
		this.cachedTokenWidth = width;
		return this.cachedTokens;
	}

	private renderTokenCacheEntry(
		token: Token,
		contentWidth: number,
		width: number,
		nextType: string | undefined,
		contextKey: string | undefined,
		cached: RenderedTokenCacheEntry | undefined,
	): RenderedTokenCacheEntry {
		if (
			cached &&
			cached.type === token.type &&
			cached.raw === token.raw &&
			cached.contextKey === contextKey &&
			cached.nextType === nextType
		) {
			return cached;
		}

		if (token.type === "code" && this.canRetainCodeLayout()) {
			const codeToken = token as Tokens.Code;
			if (cached?.type === "code" && cached.code) {
				const updated = this.updateRetainedCodeEntry(
					cached,
					codeToken,
					contentWidth,
					width,
					nextType,
					contextKey,
				);
				if (updated) return updated;
			}
			return this.createRetainedCodeEntry(codeToken, contentWidth, width, nextType, contextKey);
		}

		if (token.type === "list") {
			const listToken = token as Tokens.List;
			if (cached?.type === "list" && cached.list) {
				const updated = this.updateRetainedFlatListEntry(
					cached,
					listToken,
					contentWidth,
					width,
					nextType,
					contextKey,
				);
				if (updated) return updated;
			}
			const retained = this.createRetainedFlatListEntry(
				listToken,
				contentWidth,
				width,
				nextType,
				contextKey,
			);
			if (retained) return retained;
		}

		if (token.type === "table") {
			const tableToken = token as Tokens.Table;
			if (cached?.type === "table" && cached.table) {
				const updated = this.updateRetainedTableEntry(
					cached,
					tableToken,
					contentWidth,
					width,
					nextType,
					contextKey,
				);
				if (updated) return updated;
			}
			const retained = this.createRetainedTableEntry(
				tableToken,
				contentWidth,
				width,
				nextType,
				contextKey,
			);
			if (retained) return retained;
		}

		if (token.type === "paragraph") {
			const paragraphToken = token as Tokens.Paragraph;
			if (cached?.type === "paragraph" && cached.richParagraph) {
				const updated = this.updateRetainedRichParagraphEntry(
					cached,
					paragraphToken,
					contentWidth,
					width,
					nextType,
					contextKey,
				);
				if (updated) return updated;
			}
			if (cached?.type === "paragraph" && cached.paragraph) {
				const updated = this.updateRetainedPlainParagraphEntry(
					cached,
					paragraphToken,
					contentWidth,
					width,
					nextType,
					contextKey,
				);
				if (updated) return updated;
			}
			const entry = {
				type: token.type,
				raw: token.raw,
				contextKey,
				nextType,
				lines: this.renderTokenContentLines(token, contentWidth, width, nextType),
			};
			const richParagraph = this.createRetainedRichParagraphCache(
				paragraphToken,
				entry.lines,
				contentWidth,
				width,
				nextType,
				contextKey,
			);
			if (richParagraph) return { ...entry, richParagraph };
			const plainText = this.retainablePlainParagraphText(paragraphToken, nextType);
			if (plainText === null) return entry;
			const paragraph: RenderedPlainParagraphCache = {
				text: plainText,
				sourceToken: paragraphToken,
			};
			const lastSourceLineStart = plainText.lastIndexOf("\n") + 1;
			if (lastSourceLineStart > 0) {
				const finalSourceLines = this.renderLogicalLines(
					[plainText.slice(lastSourceLineStart)],
					contentWidth,
					width,
				);
				const lastSourceLineOutputStart = entry.lines.length - finalSourceLines.length;
				if (
					lastSourceLineOutputStart < 0 ||
					!finalSourceLines.every(
						(line, index) => entry.lines[lastSourceLineOutputStart + index] === line,
					)
				) return entry;
				paragraph.lastSourceLineStart = lastSourceLineStart;
				paragraph.lastSourceLineOutputStart = lastSourceLineOutputStart;
			}
			return { ...entry, paragraph };
		}

		if (token.type === "blockquote") {
			const blockquoteToken = token as Tokens.Blockquote;
			if (cached?.type === "blockquote" && cached.blockquote) {
				const updated = this.updateRetainedPlainBlockquoteEntry(
					cached,
					blockquoteToken,
					contentWidth,
					width,
					nextType,
					contextKey,
				);
				if (updated) return updated;
			}
			const entry = {
				type: token.type,
				raw: token.raw,
				contextKey,
				nextType,
				lines: this.renderTokenContentLines(token, contentWidth, width, nextType),
			};
			const plainText = this.retainablePlainBlockquoteText(blockquoteToken, nextType);
			if (plainText === null || contextKey !== undefined || entry.lines.length === 0) return entry;
			const lastSourceLineStart = plainText.lastIndexOf("\n") + 1;
			const finalSourceLines = this.renderPlainBlockquoteText(
				plainText.slice(lastSourceLineStart),
				contentWidth,
				width,
				lastSourceLineStart > 0,
			);
			const lastSourceLineOutputStart = entry.lines.length - finalSourceLines.length;
			if (
				lastSourceLineOutputStart < 0 ||
				!finalSourceLines.every(
					(line, index) => entry.lines[lastSourceLineOutputStart + index] === line,
				)
			) return entry;
			return {
				...entry,
				blockquote: {
					text: plainText,
					lastSourceLineStart,
					lastSourceLineOutputStart,
					sourceToken: blockquoteToken,
				},
			};
		}

		return {
			type: token.type,
			raw: token.raw,
			contextKey,
			nextType,
			lines: this.renderTokenContentLines(token, contentWidth, width, nextType),
		};
	}

	private canRetainCodeLayout(): boolean {
		return this.theme.highlightCode === undefined &&
			(this.options.codeBlockPreviewLines === undefined || this.options.codeBlockPreviewLines <= 0);
	}

	private createRetainedCodeEntry(
		token: Tokens.Code,
		contentWidth: number,
		width: number,
		nextType: string | undefined,
		contextKey: string | undefined,
	): RenderedTokenCacheEntry {
		const indent = this.theme.codeBlockIndent ?? "  ";
		const opening = this.renderLogicalLines(
			[this.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`)],
			contentWidth,
			width,
		);
		const lines = [...opening];
		const bodyLineEnds: number[] = [];
		for (const codeLine of token.text.split("\n")) {
			lines.push(...this.renderLogicalLines(
				[`${indent}${this.theme.codeBlock(codeLine)}`],
				contentWidth,
				width,
			));
			bodyLineEnds.push(lines.length);
		}
		lines.push(...this.renderCodeTrailingLines(contentWidth, width, nextType));
		return {
			type: token.type,
			raw: token.raw,
			contextKey,
			nextType,
			lines,
			code: {
				text: token.text,
				lang: token.lang,
				openingLineCount: opening.length,
				bodyLineEnds,
				sourceToken: token,
			},
		};
	}

	private updateRetainedCodeEntry(
		cached: RenderedTokenCacheEntry,
		token: Tokens.Code,
		contentWidth: number,
		width: number,
		nextType: string | undefined,
		contextKey: string | undefined,
	): RenderedTokenCacheEntry | null {
		const code = cached.code;
		const appendProven = code && this.appendedTokenSources.get(token) === code.sourceToken;
		if (
			!code ||
			code.lang !== token.lang ||
			(!appendProven && (
				!token.raw.startsWith(cached.raw) ||
				!token.text.startsWith(code.text)
			))
		) {
			return null;
		}

		const stableBodyLineCount = Math.max(0, code.bodyLineEnds.length - 1);
		const keepLineCount = stableBodyLineCount === 0
			? code.openingLineCount
			: (code.bodyLineEnds[stableBodyLineCount - 1] ?? code.openingLineCount);
		const sourceStart = code.text.lastIndexOf("\n") + 1;
		const indent = this.theme.codeBlockIndent ?? "  ";
		const replacement: string[] = [];
		code.bodyLineEnds.splice(stableBodyLineCount);
		for (const codeLine of token.text.slice(sourceStart).split("\n")) {
			replacement.push(...this.renderLogicalLines(
				[`${indent}${this.theme.codeBlock(codeLine)}`],
				contentWidth,
				width,
			));
			code.bodyLineEnds.push(keepLineCount + replacement.length);
		}
		replacement.push(...this.renderCodeTrailingLines(contentWidth, width, nextType));
		cached.lines.splice(keepLineCount, cached.lines.length - keepLineCount, ...replacement);
		cached.raw = token.raw;
		cached.contextKey = contextKey;
		cached.nextType = nextType;
		code.text = token.text;
		code.sourceToken = token;
		return cached;
	}

	private createRetainedFlatListEntry(
		token: Tokens.List,
		contentWidth: number,
		width: number,
		nextType: string | undefined,
		contextKey: string | undefined,
	): RenderedTokenCacheEntry | null {
		if (!this.flatListInfo(token) || nextType !== undefined) return null;
		const lines: string[] = [];
		const itemLineEnds: number[] = [];
		for (let index = 0; index < token.items.length; index += 1) {
			lines.push(...this.renderLogicalLines(
				this.renderListItem(token, token.items[index]!, index, 0, contentWidth),
				contentWidth,
				width,
			));
			itemLineEnds.push(lines.length);
		}
		return {
			type: token.type,
			raw: token.raw,
			contextKey,
			nextType,
			lines,
			list: { itemLineEnds, sourceToken: token },
		};
	}

	private updateRetainedFlatListEntry(
		cached: RenderedTokenCacheEntry,
		token: Tokens.List,
		contentWidth: number,
		width: number,
		nextType: string | undefined,
		contextKey: string | undefined,
	): RenderedTokenCacheEntry | null {
		const list = cached.list;
		const update = this.appendedListUpdates.get(token);
		if (
			!list ||
			!update ||
			update.sourceToken !== list.sourceToken ||
			nextType !== undefined ||
			!this.flatListInfo(token) ||
			update.stableItemCount < 0 ||
			update.stableItemCount >= token.items.length ||
			update.stableItemCount > list.itemLineEnds.length
		) return null;

		const keepLineCount = update.stableItemCount === 0
			? 0
			: (list.itemLineEnds[update.stableItemCount - 1] ?? 0);
		const replacement: string[] = [];
		list.itemLineEnds.splice(update.stableItemCount);
		for (let index = update.stableItemCount; index < token.items.length; index += 1) {
			replacement.push(...this.renderLogicalLines(
				this.renderListItem(token, token.items[index]!, index, 0, contentWidth),
				contentWidth,
				width,
			));
			list.itemLineEnds.push(keepLineCount + replacement.length);
		}
		cached.lines.splice(keepLineCount, cached.lines.length - keepLineCount, ...replacement);
		cached.raw = token.raw;
		cached.contextKey = contextKey;
		cached.nextType = nextType;
		list.sourceToken = token;
		return cached;
	}

	private createRetainedTableEntry(
		token: Tokens.Table,
		contentWidth: number,
		width: number,
		nextType: string | undefined,
		contextKey: string | undefined,
	): RenderedTokenCacheEntry | null {
		if (nextType !== undefined || contextKey !== undefined || token.rows.length === 0) return null;
		const layout = this.tableColumnLayout(token, contentWidth);
		if (!layout) return null;
		const rendered = this.renderTableLines(token, layout.columnWidths);
		const lines = this.renderLogicalLines(rendered.lines, contentWidth, width);
		if (lines.length !== rendered.lines.length) return null;
		return {
			type: token.type,
			raw: token.raw,
			contextKey,
			nextType,
			lines,
			table: {
				...layout,
				rowBoundaryStarts: rendered.rowBoundaryStarts,
				bottomLineStart: rendered.bottomLineStart,
				finalRowMetrics: this.tableRowMetrics(token.rows[token.rows.length - 1]!, token.header.length),
				sourceToken: token,
			},
		};
	}

	private updateRetainedTableEntry(
		cached: RenderedTokenCacheEntry,
		token: Tokens.Table,
		contentWidth: number,
		width: number,
		nextType: string | undefined,
		contextKey: string | undefined,
	): RenderedTokenCacheEntry | null {
		const table = cached.table;
		if (
			!table ||
			nextType !== undefined ||
			contextKey !== undefined ||
			token.rows.length === 0 ||
			this.appendedTokenSources.get(token) !== table.sourceToken ||
			table.rowBoundaryStarts.length !== table.sourceToken.rows.length ||
			token.header.length !== table.columnWidths.length ||
			token.raw.length < table.sourceToken.raw.length
		) return null;

		const previousToken = table.sourceToken;
		const appended = token.raw.slice(previousToken.raw.length);
		const stableRowCount = previousToken.raw.endsWith("\n") || appended.startsWith("\n")
			? previousToken.rows.length
			: Math.max(0, previousToken.rows.length - 1);
		if (stableRowCount > token.rows.length) return null;
		const changedRows = token.rows.slice(stableRowCount);
		if (stableRowCount < previousToken.rows.length && changedRows.length === 0) return null;

		const changedMetrics = changedRows.map((row) => this.tableRowMetrics(row, token.header.length));
		if (
			stableRowCount < previousToken.rows.length &&
			!this.tableMetricsDominate(changedMetrics[0]!, table.finalRowMetrics)
		) return null;

		const naturalWidths = [...table.naturalWidths];
		const minWordWidths = [...table.minWordWidths];
		for (const metrics of changedMetrics) {
			for (let index = 0; index < token.header.length; index += 1) {
				naturalWidths[index] = Math.max(naturalWidths[index] ?? 0, metrics.naturalWidths[index] ?? 0);
				minWordWidths[index] = Math.max(minWordWidths[index] ?? 1, metrics.minWordWidths[index] ?? 1);
			}
		}
		const columnWidths = this.resolveTableColumnWidths(
			naturalWidths,
			minWordWidths,
			contentWidth,
		);
		if (!columnWidths || !this.numberArraysEqual(columnWidths, table.columnWidths)) return null;

		if (changedRows.length > 0) {
			const keepLineCount = stableRowCount < previousToken.rows.length
				? table.rowBoundaryStarts[stableRowCount]
				: table.bottomLineStart;
			if (keepLineCount === undefined || keepLineCount < 0 || keepLineCount > cached.lines.length) return null;
			const rendered = this.renderTableSuffix(changedRows, columnWidths);
			const replacement = this.renderLogicalLines(rendered.lines, contentWidth, width);
			if (replacement.length !== rendered.lines.length) return null;
			cached.lines.splice(keepLineCount, cached.lines.length - keepLineCount, ...replacement);
			table.rowBoundaryStarts.splice(
				stableRowCount,
				table.rowBoundaryStarts.length - stableRowCount,
				...rendered.rowBoundaryStarts.map((start) => keepLineCount + start),
			);
			table.bottomLineStart = keepLineCount + rendered.bottomLineStart;
			table.finalRowMetrics = changedMetrics[changedMetrics.length - 1]!;
		}

		cached.raw = token.raw;
		cached.contextKey = contextKey;
		cached.nextType = nextType;
		table.naturalWidths = naturalWidths;
		table.minWordWidths = minWordWidths;
		table.columnWidths = columnWidths;
		table.sourceToken = token;
		return cached;
	}

	private tableMetricsDominate(next: TableRowMetrics, previous: TableRowMetrics): boolean {
		return next.naturalWidths.every((width, index) => width >= (previous.naturalWidths[index] ?? 0)) &&
			next.minWordWidths.every((width, index) => width >= (previous.minWordWidths[index] ?? 1));
	}

	private numberArraysEqual(left: readonly number[], right: readonly number[]): boolean {
		return left.length === right.length && left.every((value, index) => value === right[index]);
	}

	private createRetainedRichParagraphCache(
		token: Tokens.Paragraph,
		lines: readonly string[],
		contentWidth: number,
		width: number,
		nextType: string | undefined,
		contextKey: string | undefined,
	): RenderedRichParagraphCache | null {
		if (this.defaultTextStyle !== undefined || nextType !== undefined || contextKey !== undefined) {
			return null;
		}
		const info = this.streamingInlineParagraphInfo(token);
		const inlineTokens = token.tokens ?? [];
		if (!info || info.stableInlineCount <= 0 || info.stableInlineCount >= inlineTokens.length) {
			return null;
		}

		const changedSource = this.renderInlineTokens(inlineTokens.slice(info.stableInlineCount));
		let stableTailSource = "";
		let boundaryTokens = 0;
		for (let index = info.stableInlineCount; index >= 0; index -= 1) {
			if (index < info.stableInlineCount) {
				stableTailSource = this.renderInlineTokens([inlineTokens[index]!]) + stableTailSource;
				boundaryTokens += 1;
				if (boundaryTokens > MAX_INLINE_TAIL_BOUNDARY_TOKENS) break;
			}
			const replacement = this.renderLogicalLines(
				[stableTailSource + changedSource],
				contentWidth,
				width,
			);
			const stableOutputLineCount = lines.length - replacement.length;
			if (stableOutputLineCount > 0 && this.linesEndWith(lines, replacement)) {
				return {
					stableInlineCount: info.stableInlineCount,
					stableOutputLineCount,
					stableTailSource,
					sourceToken: token,
				};
			}
		}
		return null;
	}

	private updateRetainedRichParagraphEntry(
		cached: RenderedTokenCacheEntry,
		token: Tokens.Paragraph,
		contentWidth: number,
		width: number,
		nextType: string | undefined,
		contextKey: string | undefined,
	): RenderedTokenCacheEntry | null {
		const richParagraph = cached.richParagraph;
		const appended = this.appendedInlineParagraphUpdates.get(token);
		const info = this.streamingInlineParagraphInfo(token);
		const inlineTokens = token.tokens ?? [];
		if (
			!richParagraph ||
			!appended ||
			!info ||
			this.defaultTextStyle !== undefined ||
			nextType !== undefined ||
			contextKey !== undefined ||
			appended.sourceToken !== richParagraph.sourceToken ||
			appended.stableInlineCount !== richParagraph.stableInlineCount ||
			info.stableInlineCount < richParagraph.stableInlineCount ||
			info.stableInlineCount >= inlineTokens.length ||
			richParagraph.stableOutputLineCount <= 0 ||
			richParagraph.stableOutputLineCount > cached.lines.length
		) return null;

		const newStableSegments = inlineTokens
			.slice(richParagraph.stableInlineCount, info.stableInlineCount)
			.map((inlineToken) => this.renderInlineTokens([inlineToken]));
		const stableSegments = [richParagraph.stableTailSource, ...newStableSegments];
		const stableTailSource = stableSegments.join("");
		const changedSource = this.renderInlineTokens(inlineTokens.slice(info.stableInlineCount));
		const replacement = this.renderLogicalLines(
			[stableTailSource + changedSource],
			contentWidth,
			width,
		);
		cached.lines.splice(
			richParagraph.stableOutputLineCount,
			cached.lines.length - richParagraph.stableOutputLineCount,
			...replacement,
		);

		let retainedLineCount = 0;
		let nextStableTailSource = stableTailSource;
		const earliestCandidate = Math.max(1, stableSegments.length - MAX_INLINE_TAIL_BOUNDARY_TOKENS);
		for (let index = stableSegments.length; index >= earliestCandidate; index -= 1) {
			const candidateTailSource = stableSegments.slice(index).join("");
			const candidateLines = this.renderLogicalLines(
				[candidateTailSource + changedSource],
				contentWidth,
				width,
			);
			const candidateRetainedLineCount = replacement.length - candidateLines.length;
			if (candidateRetainedLineCount > 0 && this.linesEndWith(replacement, candidateLines)) {
				retainedLineCount = candidateRetainedLineCount;
				nextStableTailSource = candidateTailSource;
				break;
			}
		}

		cached.raw = token.raw;
		cached.contextKey = contextKey;
		cached.nextType = nextType;
		richParagraph.stableInlineCount = info.stableInlineCount;
		richParagraph.stableOutputLineCount += retainedLineCount;
		richParagraph.stableTailSource = nextStableTailSource;
		richParagraph.sourceToken = token;
		return cached;
	}

	private linesEndWith(lines: readonly string[], suffix: readonly string[]): boolean {
		if (suffix.length > lines.length) return false;
		const offset = lines.length - suffix.length;
		return suffix.every((line, index) => lines[offset + index] === line);
	}

	private retainablePlainParagraphText(
		token: Tokens.Paragraph,
		nextType: string | undefined,
	): string | null {
		if (this.defaultTextStyle !== undefined || nextType !== undefined) {
			return null;
		}
		const inlineTokens = token.tokens ?? [];
		if (inlineTokens.length !== 1) return null;
		const inline = inlineTokens[0];
		if (
			!inline ||
			inline.type !== "text" ||
			inline.raw !== token.text ||
			inline.text !== token.text
		) return null;
		return token.text;
	}

	private updateRetainedPlainParagraphEntry(
		cached: RenderedTokenCacheEntry,
		token: Tokens.Paragraph,
		contentWidth: number,
		width: number,
		nextType: string | undefined,
		contextKey: string | undefined,
	): RenderedTokenCacheEntry | null {
		const paragraph = cached.paragraph;
		const nextText = this.retainablePlainParagraphText(token, nextType);
		const appendProven = paragraph && this.appendedTokenSources.get(token) === paragraph.sourceToken;
		if (
			!paragraph ||
			nextText === null ||
			contextKey !== undefined ||
			(!appendProven && (
				!token.raw.startsWith(cached.raw) ||
				!nextText.startsWith(paragraph.text)
			)) ||
			cached.lines.length === 0
		) return null;
		if (
			paragraph.lastSourceLineStart !== undefined &&
			paragraph.lastSourceLineOutputStart !== undefined
		) {
			const replacement = this.renderLogicalLines(
				[nextText.slice(paragraph.lastSourceLineStart)],
				contentWidth,
				width,
			);
			const lastSourceLineStart = nextText.lastIndexOf("\n") + 1;
			const finalSourceLines = this.renderLogicalLines(
				[nextText.slice(lastSourceLineStart)],
				contentWidth,
				width,
			);
			const lastSourceLineOutputStart = paragraph.lastSourceLineOutputStart
				+ replacement.length
				- finalSourceLines.length;
			cached.lines.splice(
				paragraph.lastSourceLineOutputStart,
				cached.lines.length - paragraph.lastSourceLineOutputStart,
				...replacement,
			);
			cached.raw = token.raw;
			cached.contextKey = contextKey;
			cached.nextType = nextType;
			paragraph.text = nextText;
			paragraph.lastSourceLineStart = lastSourceLineStart;
			paragraph.lastSourceLineOutputStart = lastSourceLineOutputStart;
			paragraph.sourceToken = token;
			return cached;
		}

		const previousText = paragraph.text.trimEnd();
		const previousLine = cached.lines[cached.lines.length - 1]!;
		const leftMargin = " ".repeat(this.paddingX);
		if (!previousLine.startsWith(leftMargin)) return null;
		const previousLineText = previousLine.slice(leftMargin.length).trimEnd();
		if (!previousLineText || !previousText.endsWith(previousLineText)) return null;

		const sourceStart = previousText.length - previousLineText.length;
		const replacement = this.renderLogicalLines(
			[nextText.slice(sourceStart)],
			contentWidth,
			width,
		);
		cached.lines.splice(cached.lines.length - 1, 1, ...replacement);
		cached.raw = token.raw;
		cached.contextKey = contextKey;
		cached.nextType = nextType;
		paragraph.text = nextText;
		const lastSourceLineStart = nextText.lastIndexOf("\n") + 1;
		if (lastSourceLineStart > 0) {
			const finalSourceLines = this.renderLogicalLines(
				[nextText.slice(lastSourceLineStart)],
				contentWidth,
				width,
			);
			paragraph.lastSourceLineStart = lastSourceLineStart;
			paragraph.lastSourceLineOutputStart = cached.lines.length - finalSourceLines.length;
		}
		paragraph.sourceToken = token;
		return cached;
	}

	private retainablePlainBlockquoteText(
		token: Tokens.Blockquote,
		nextType: string | undefined,
	): string | null {
		if (nextType !== undefined || token.tokens.length !== 1) return null;
		const paragraph = token.tokens[0];
		if (
			!paragraph ||
			paragraph.type !== "paragraph" ||
			token.text !== paragraph.text ||
			paragraph.raw !== paragraph.text
		) return null;
		const inlineTokens = paragraph.tokens ?? [];
		if (inlineTokens.length !== 1) return null;
		const inline = inlineTokens[0];
		if (
			!inline ||
			inline.type !== "text" ||
			inline.raw !== paragraph.text ||
			inline.text !== paragraph.text
		) return null;
		return paragraph.text;
	}

	private updateRetainedPlainBlockquoteEntry(
		cached: RenderedTokenCacheEntry,
		token: Tokens.Blockquote,
		contentWidth: number,
		width: number,
		nextType: string | undefined,
		contextKey: string | undefined,
	): RenderedTokenCacheEntry | null {
		const blockquote = cached.blockquote;
		const nextText = this.retainablePlainBlockquoteText(token, nextType);
		if (
			!blockquote ||
			nextText === null ||
			contextKey !== undefined ||
			this.appendedTokenSources.get(token) !== blockquote.sourceToken ||
			!nextText.startsWith(blockquote.text) ||
			blockquote.lastSourceLineOutputStart < 0 ||
			blockquote.lastSourceLineOutputStart > cached.lines.length
		) return null;

		const replacement = this.renderPlainBlockquoteText(
			nextText.slice(blockquote.lastSourceLineStart),
			contentWidth,
			width,
			blockquote.lastSourceLineStart > 0,
		);
		const lastSourceLineStart = nextText.lastIndexOf("\n") + 1;
		const finalSourceLines = this.renderPlainBlockquoteText(
			nextText.slice(lastSourceLineStart),
			contentWidth,
			width,
			lastSourceLineStart > 0,
		);
		const lastSourceLineOutputStart = blockquote.lastSourceLineOutputStart
			+ replacement.length
			- finalSourceLines.length;
		cached.lines.splice(
			blockquote.lastSourceLineOutputStart,
			cached.lines.length - blockquote.lastSourceLineOutputStart,
			...replacement,
		);
		cached.raw = token.raw;
		cached.contextKey = contextKey;
		cached.nextType = nextType;
		blockquote.text = nextText;
		blockquote.lastSourceLineStart = lastSourceLineStart;
		blockquote.lastSourceLineOutputStart = lastSourceLineOutputStart;
		blockquote.sourceToken = token;
		return cached;
	}

	private renderPlainBlockquoteText(
		text: string,
		contentWidth: number,
		width: number,
		continuesPreviousLine: boolean,
	): string[] {
		const quoteStyle = (value: string) => this.theme.quote(this.theme.italic(value));
		const quoteStylePrefix = this.getStylePrefix(quoteStyle);
		const source = continuesPreviousLine ? `.\n${text}` : text;
		const styledText = quoteStylePrefix
			? quoteStyle(source.replaceAll(ANSI_FULL_RESET, `\x1b[0m${quoteStylePrefix}`))
			: quoteStyle(source);
		const quoteContentWidth = Math.max(1, contentWidth - 2);
		const quoteLines = wrapTextWithAnsi(styledText, quoteContentWidth);
		if (continuesPreviousLine) quoteLines.shift();
		const logicalLines = quoteLines.map(
			(line) => this.theme.quoteBorder(`${this.theme.glyphs?.vertical ?? "│"} `) + line,
		);
		return this.renderLogicalLines(logicalLines, contentWidth, width);
	}

	private renderCodeTrailingLines(
		contentWidth: number,
		width: number,
		nextType: string | undefined,
	): string[] {
		return this.renderLogicalLines([
			this.theme.codeBlockBorder("```"),
			...(nextType && nextType !== "space" ? [""] : []),
		], contentWidth, width);
	}

	private updateSourceTokens(): MarkdownTokenUpdate {
		const source = this.normalizedText;
		if (this.cachedLexedText === source) {
			return { tokens: this.cachedSourceTokens, stablePrefixLength: this.cachedSourceTokens.length, changed: false };
		}

		if (this.canReuseAppendedSource(source)) {
			let reparseTokenIndex = this.cachedSourceTokens.length - 1;
			while (reparseTokenIndex > 0 && this.cachedSourceTokens[reparseTokenIndex]?.type === "space") {
				reparseTokenIndex -= 1;
			}
			const reparseOffset = reparseTokenIndex > 0
				? (this.cachedSourceTokenEnds[reparseTokenIndex - 1] ?? 0)
				: 0;
			const fenceUpdate = this.updateOpenFenceToken(
				source,
				reparseTokenIndex,
				reparseOffset,
				this.pendingNormalizedAppend,
			);
			if (fenceUpdate) return fenceUpdate;
			if (this.hasReferenceSyntax) return this.replaceSourceTokens(source);
			const listUpdate = this.updateOpenListToken(
				source,
				reparseTokenIndex,
				reparseOffset,
				this.pendingNormalizedAppend,
			);
			if (listUpdate) return listUpdate;
			const tableUpdate = this.updateOpenTableToken(
				source,
				reparseTokenIndex,
				reparseOffset,
				this.pendingNormalizedAppend,
			);
			if (tableUpdate) return tableUpdate;
			const inlineParagraphUpdate = this.updateOpenInlineParagraphToken(
				source,
				reparseTokenIndex,
				reparseOffset,
				this.pendingNormalizedAppend,
			);
			if (inlineParagraphUpdate) return inlineParagraphUpdate;
			const suffixSource = source.slice(reparseOffset);
			const suffixTokens = this.lexSource(suffixSource);
			const suffixEnds = this.tokenEndOffsets(suffixTokens, reparseOffset);
			if (suffixEnds.at(-1) === source.length || (suffixTokens.length === 0 && reparseOffset === source.length)) {
				const previousReparseToken = this.cachedSourceTokens[reparseTokenIndex];
				const nextReparseToken = suffixTokens[0];
				if (
					previousReparseToken &&
					nextReparseToken &&
					nextReparseToken.raw.length >= previousReparseToken.raw.length &&
					(this.cachedSourceTokenEnds[reparseTokenIndex] ?? -1) === reparseOffset + previousReparseToken.raw.length
				) {
					this.appendedTokenSources.set(nextReparseToken, previousReparseToken);
				}
				this.cachedSourceTokens.splice(
					reparseTokenIndex,
					this.cachedSourceTokens.length - reparseTokenIndex,
					...suffixTokens,
				);
				this.cachedSourceTokenEnds.splice(
					reparseTokenIndex,
					this.cachedSourceTokenEnds.length - reparseTokenIndex,
					...suffixEnds,
				);
				this.commitLexedSource(source);
				return {
					tokens: this.cachedSourceTokens,
					stablePrefixLength: reparseTokenIndex,
					changed: true,
				};
			}
		}

		return this.replaceSourceTokens(source);
	}

	private canReuseAppendedSource(source: string): boolean {
		if (
			this.cachedLexedText === undefined ||
			this.cachedSourceTokens.length === 0 ||
			!this.normalizedTextExtendsLexedText ||
			this.pendingNormalizedAppend.length === 0
		) {
			return false;
		}
		if (source.length !== this.cachedLexedText.length + this.pendingNormalizedAppend.length) {
			return false;
		}
		return this.cachedSourceTokenEnds.at(-1) === this.cachedLexedText.length;
	}

	private updateOpenFenceToken(
		source: string,
		tokenIndex: number,
		sourceOffset: number,
		appended: string,
	): MarkdownTokenUpdate | null {
		if (tokenIndex !== this.cachedSourceTokens.length - 1) return null;
		const token = this.cachedSourceTokens[tokenIndex];
		if (!token || token.type !== "code") return null;
		const fence = this.openFenceInfo(token);
		if (!fence) return null;

		if (
			!appended ||
			appended.includes("\r") ||
			token.raw.length !== (this.cachedLexedText?.length ?? 0) - sourceOffset
		) return null;
		const boundarySource = token.raw.slice(token.raw.lastIndexOf("\n") + 1) + appended;
		if (this.hasClosingFence(boundarySource, fence)) return null;

		const raw = `${token.raw}${appended}`;
		const body = raw.slice(fence.bodyOffset);
		const nextToken: Tokens.Code = {
			...(token as Tokens.Code),
			raw,
			text: body.endsWith("\n") ? body.slice(0, -1) : body,
		};
		this.appendedTokenSources.set(nextToken, token);
		this.cachedSourceTokens.splice(tokenIndex, 1, nextToken);
		this.cachedSourceTokenEnds.splice(tokenIndex, 1, source.length);
		this.cachedOpenFences.set(nextToken, fence);
		this.commitLexedSource(source);
		return {
			tokens: this.cachedSourceTokens,
			stablePrefixLength: tokenIndex,
			changed: true,
		};
	}

	private updateOpenListToken(
		source: string,
		tokenIndex: number,
		sourceOffset: number,
		appended: string,
	): MarkdownTokenUpdate | null {
		if (tokenIndex !== this.cachedSourceTokens.length - 1) return null;
		const token = this.cachedSourceTokens[tokenIndex];
		if (!token || token.type !== "list") return null;
		const listToken = token as Tokens.List;
		const listInfo = this.flatListInfo(listToken);
		const lastItem = listToken.items[listToken.items.length - 1];
		if (
			!listInfo ||
			!lastItem ||
			!appended ||
			appended.includes("\r") ||
			listToken.raw.length !== (this.cachedLexedText?.length ?? 0) - sourceOffset
		) return null;

		const boundarySource = `${listToken.raw.slice(listInfo.lastItemOffset)}${appended}`;
		const boundaryTokens = this.lexSource(boundarySource);
		if (boundaryTokens.length !== 1 || boundaryTokens[0]?.type !== "list") return null;
		const boundaryList = boundaryTokens[0] as Tokens.List;
		const boundaryInfo = this.flatListInfo(boundaryList);
		const boundaryFirstItem = boundaryList.items[0];
		if (
			!boundaryInfo ||
			boundaryInfo.ordered !== listInfo.ordered ||
			boundaryInfo.marker !== listInfo.marker ||
			boundaryList.raw.length !== boundarySource.length ||
			!boundaryFirstItem?.raw.startsWith(lastItem.raw)
		) return null;

		const stableItemCount = listToken.items.length - 1;
		const nextRaw = `${listToken.raw.slice(0, listInfo.lastItemOffset)}${boundaryList.raw}`;
		if (nextRaw.length !== source.length - sourceOffset) return null;
		listToken.items.splice(stableItemCount, 1, ...boundaryList.items);
		const nextToken: Tokens.List = {
			...listToken,
			raw: nextRaw,
			items: listToken.items,
		};

		this.appendedTokenSources.set(nextToken, listToken);
		this.appendedListUpdates.set(nextToken, { sourceToken: listToken, stableItemCount });
		this.cachedFlatLists.set(nextToken, {
			...listInfo,
			lastItemOffset: listInfo.lastItemOffset + boundaryInfo.lastItemOffset,
		});
		this.cachedSourceTokens.splice(tokenIndex, 1, nextToken);
		this.cachedSourceTokenEnds.splice(tokenIndex, 1, source.length);
		this.commitLexedSource(source);
		return {
			tokens: this.cachedSourceTokens,
			stablePrefixLength: tokenIndex,
			changed: true,
		};
	}

	private updateOpenTableToken(
		source: string,
		tokenIndex: number,
		sourceOffset: number,
		appended: string,
	): MarkdownTokenUpdate | null {
		if (tokenIndex !== this.cachedSourceTokens.length - 1) return null;
		const token = this.cachedSourceTokens[tokenIndex];
		if (!token || token.type !== "table") return null;
		const tableToken = token as Tokens.Table;
		const tableInfo = this.streamingTableInfo(tableToken);
		if (
			!tableInfo ||
			!appended ||
			appended.includes("\r") ||
			tableToken.raw.length !== (this.cachedLexedText?.length ?? 0) - sourceOffset
		) return null;

		const boundarySource = tableToken.raw.slice(tableInfo.lastRowOffset) + appended;
		const syntheticSource = tableInfo.headerSource + boundarySource;
		const boundaryTokens = this.lexSource(syntheticSource);
		if (boundaryTokens.length !== 1 || boundaryTokens[0]?.type !== "table") return null;
		const boundaryTable = boundaryTokens[0] as Tokens.Table;
		const boundaryInfo = this.streamingTableInfo(boundaryTable);
		if (
			!boundaryInfo ||
			boundaryTable.raw.length !== syntheticSource.length ||
			boundaryTable.header.length !== tableToken.header.length ||
			!boundaryTable.header.every((cell, index) => cell.text === tableToken.header[index]?.text) ||
			!boundaryTable.align.every((align, index) => align === tableToken.align[index]) ||
			boundaryTable.rows.length === 0
		) return null;

		const stableRowCount = tableToken.rows.length - 1;
		const rows = [...tableToken.rows.slice(0, stableRowCount), ...boundaryTable.rows];
		const boundaryBody = boundaryTable.raw.slice(tableInfo.headerSource.length);
		const raw = tableToken.raw.slice(0, tableInfo.lastRowOffset) + boundaryBody;
		if (raw.length !== source.length - sourceOffset) return null;
		const nextToken: Tokens.Table = {
			...tableToken,
			raw,
			rows,
		};
		const nextLastRowOffset = tableInfo.lastRowOffset
			+ boundaryInfo.lastRowOffset
			- tableInfo.headerSource.length;

		this.appendedTokenSources.set(nextToken, tableToken);
		this.cachedStreamingTables.set(nextToken, {
			headerSource: tableInfo.headerSource,
			lastRowOffset: nextLastRowOffset,
		});
		this.cachedSourceTokens.splice(tokenIndex, 1, nextToken);
		this.cachedSourceTokenEnds.splice(tokenIndex, 1, source.length);
		this.commitLexedSource(source);
		return {
			tokens: this.cachedSourceTokens,
			stablePrefixLength: tokenIndex,
			changed: true,
		};
	}

	private updateOpenInlineParagraphToken(
		source: string,
		tokenIndex: number,
		sourceOffset: number,
		appended: string,
	): MarkdownTokenUpdate | null {
		if (tokenIndex !== this.cachedSourceTokens.length - 1) return null;
		const token = this.cachedSourceTokens[tokenIndex];
		if (!token || token.type !== "paragraph") return null;
		const paragraphToken = token as Tokens.Paragraph;
		const info = this.streamingInlineParagraphInfo(paragraphToken);
		const inlineTokens = paragraphToken.tokens ?? [];
		if (
			!info ||
			!appended ||
			appended.includes("\n") ||
			appended.includes("\r") ||
			paragraphToken.raw.length !== (this.cachedLexedText?.length ?? 0) - sourceOffset
		) return null;

		const boundarySource = paragraphToken.text.slice(info.boundaryOffset) + appended;
		const boundaryTokens = Lexer.lexInline(boundarySource, markdownParser.defaults);
		if (this.inlineTokenRawLength(boundaryTokens) !== boundarySource.length) return null;
		const raw = paragraphToken.raw + appended;
		const text = paragraphToken.text + appended;
		if (raw.length !== source.length - sourceOffset || raw !== text) return null;
		const tokens = [
			...inlineTokens.slice(0, info.stableInlineCount),
			...boundaryTokens,
		];
		if (this.inlineTokenRawLength(tokens) !== text.length) return null;

		const nextToken: Tokens.Paragraph = {
			...paragraphToken,
			raw,
			text,
			tokens,
		};
		this.appendedTokenSources.set(nextToken, paragraphToken);
		this.appendedInlineParagraphUpdates.set(nextToken, {
			sourceToken: paragraphToken,
			stableInlineCount: info.stableInlineCount,
		});
		this.cachedSourceTokens.splice(tokenIndex, 1, nextToken);
		this.cachedSourceTokenEnds.splice(tokenIndex, 1, source.length);
		this.commitLexedSource(source);
		return {
			tokens: this.cachedSourceTokens,
			stablePrefixLength: tokenIndex,
			changed: true,
		};
	}

	private flatListInfo(token: Tokens.List): FlatListInfo | null {
		if (this.cachedFlatLists.has(token)) {
			return this.cachedFlatLists.get(token) ?? null;
		}
		if (token.loose || token.items.length === 0) {
			this.cachedFlatLists.set(token, null);
			return null;
		}
		const marker = this.flatListMarker(token.items[0]!, token.ordered);
		let lastItemOffset = 0;
		let eligible = marker !== null;
		for (let index = 0; index < token.items.length; index += 1) {
			const item = token.items[index]!;
			eligible &&= this.isPlainFlatListItem(item) && this.flatListMarker(item, token.ordered) === marker;
			if (index < token.items.length - 1) lastItemOffset += item.raw.length;
		}
		eligible &&= lastItemOffset + token.items[token.items.length - 1]!.raw.length <= token.raw.length;
		const info = eligible ? { lastItemOffset, marker: marker!, ordered: token.ordered } : null;
		this.cachedFlatLists.set(token, info);
		return info;
	}

	private flatListMarker(item: Tokens.ListItem, ordered: boolean): string | null {
		const match = /^(?:([*+-])|(\d{1,9})([.)]))[ \t]+/.exec(item.raw);
		if (!match) return null;
		if (ordered) return match[2] ? `#${match[3]}` : null;
		return match[1] ?? null;
	}

	private isPlainFlatListItem(item: Tokens.ListItem): boolean {
		if (item.loose || item.task || item.text.includes("\n") || item.tokens.length !== 1) return false;
		const block = item.tokens[0];
		if (!block || block.type !== "text" || block.raw !== item.text || block.text !== item.text) return false;
		const inlineTokens = block.tokens ?? [];
		if (inlineTokens.length !== 1) return false;
		const inline = inlineTokens[0];
		return Boolean(
			inline &&
			inline.type === "text" &&
			inline.raw === item.text &&
			inline.text === item.text,
		);
	}

	private streamingTableInfo(token: Tokens.Table): StreamingTableInfo | null {
		if (this.cachedStreamingTables.has(token)) {
			return this.cachedStreamingTables.get(token) ?? null;
		}
		if (token.rows.length === 0 || token.raw.includes("\r")) {
			this.cachedStreamingTables.set(token, null);
			return null;
		}
		const headerEnd = token.raw.indexOf("\n");
		const delimiterEnd = headerEnd < 0 ? -1 : token.raw.indexOf("\n", headerEnd + 1);
		if (delimiterEnd < 0) {
			this.cachedStreamingTables.set(token, null);
			return null;
		}
		const sourceEnd = token.raw.endsWith("\n") ? token.raw.length - 1 : token.raw.length;
		const lastRowOffset = token.raw.lastIndexOf("\n", sourceEnd - 1) + 1;
		const headerSource = token.raw.slice(0, delimiterEnd + 1);
		const info = lastRowOffset >= headerSource.length && lastRowOffset < token.raw.length
			? { headerSource, lastRowOffset }
			: null;
		this.cachedStreamingTables.set(token, info);
		return info;
	}

	private streamingInlineParagraphInfo(token: Tokens.Paragraph): StreamingInlineParagraphInfo | null {
		if (this.cachedStreamingInlineParagraphs.has(token)) {
			return this.cachedStreamingInlineParagraphs.get(token) ?? null;
		}
		const inlineTokens = token.tokens ?? [];
		if (
			token.raw !== token.text ||
			token.text.includes("\n") ||
			token.text.includes("\r") ||
			token.text.includes("[") ||
			inlineTokens.length < 2 ||
			!inlineTokens.some((inlineToken) => inlineToken.type !== "text") ||
			this.inlineTokenRawLength(inlineTokens) !== token.text.length
		) {
			this.cachedStreamingInlineParagraphs.set(token, null);
			return null;
		}

		let boundaryIndex = this.inlineContextBoundary(inlineTokens, inlineTokens.length - 1);
		const unsafeStableIndex = inlineTokens.findIndex(
			(inlineToken, index) => index < boundaryIndex &&
				inlineToken.type === "text" &&
				/[\\`*_~[\]<>]/.test(inlineToken.raw),
		);
		if (unsafeStableIndex >= 0) {
			boundaryIndex = this.inlineContextBoundary(inlineTokens, unsafeStableIndex);
		}
		if (boundaryIndex <= 0) {
			this.cachedStreamingInlineParagraphs.set(token, null);
			return null;
		}

		const boundaryOffset = this.inlineTokenRawLength(inlineTokens.slice(0, boundaryIndex));
		const boundarySource = token.text.slice(boundaryOffset);
		const reparsedBoundary = Lexer.lexInline(boundarySource, markdownParser.defaults);
		if (
			this.inlineTokenRawLength(reparsedBoundary) !== boundarySource.length ||
			JSON.stringify(reparsedBoundary) !== JSON.stringify(inlineTokens.slice(boundaryIndex))
		) {
			this.cachedStreamingInlineParagraphs.set(token, null);
			return null;
		}

		const info = { boundaryOffset, stableInlineCount: boundaryIndex };
		this.cachedStreamingInlineParagraphs.set(token, info);
		return info;
	}

	private inlineContextBoundary(tokens: readonly Token[], initialIndex: number): number {
		let boundaryIndex = initialIndex;
		while (boundaryIndex > 0) {
			boundaryIndex -= 1;
			if (/\s/.test(tokens[boundaryIndex]!.raw)) break;
		}
		return boundaryIndex;
	}

	private inlineTokenRawLength(tokens: readonly Token[]): number {
		return tokens.reduce((length, token) => length + token.raw.length, 0);
	}

	private openFenceInfo(token: Token): OpenFenceInfo | null {
		if (this.cachedOpenFences.has(token)) {
			return this.cachedOpenFences.get(token) ?? null;
		}
		if (token.type !== "code" || (token as Tokens.Code).codeBlockStyle === "indented") {
			this.cachedOpenFences.set(token, null);
			return null;
		}
		const opening = /^( {0,3})(`{3,}|~{3,})[^\n]*\n/.exec(token.raw);
		if (!opening || opening[1] !== "") {
			this.cachedOpenFences.set(token, null);
			return null;
		}
		const markerText = opening[2]!;
		const trailingFenceMarkers = "[~`]*";
		const fence: OpenFenceInfo = {
			bodyOffset: opening[0].length,
			closingPattern: new RegExp(
				`(?:^|\\n) {0,3}${markerText}${trailingFenceMarkers}[ \\t]*(?:\\n|$)`,
			),
		};
		const body = token.raw.slice(fence.bodyOffset);
		const result = this.hasClosingFence(body, fence) ? null : fence;
		this.cachedOpenFences.set(token, result);
		return result;
	}

	private hasClosingFence(source: string, fence: OpenFenceInfo): boolean {
		return fence.closingPattern.test(source);
	}

	private replaceSourceTokens(source: string): MarkdownTokenUpdate {
		const tokens = this.lexSource(source);
		this.cachedSourceTokens = tokens;
		this.cachedSourceTokenEnds = this.tokenEndOffsets(tokens);
		this.commitLexedSource(source);
		return { tokens, stablePrefixLength: 0, changed: true };
	}

	private commitLexedSource(source: string): void {
		this.cachedLexedText = source;
		this.normalizedTextExtendsLexedText = true;
		this.pendingNormalizedAppend = "";
	}

	private lexSource(source: string): Token[] {
		return Array.from(markdownParser.lexer(source));
	}

	private tokenEndOffsets(tokens: Token[], initialOffset = 0): number[] {
		const offsets: number[] = [];
		let offset = initialOffset;
		for (const token of tokens) {
			offset += token.raw.length;
			offsets.push(offset);
		}
		return offsets;
	}

	private renderTokenContentLines(
		token: Token,
		contentWidth: number,
		width: number,
		nextTokenType?: string,
	): string[] {
		return this.renderLogicalLines(
			this.renderToken(token, contentWidth, nextTokenType),
			contentWidth,
			width,
		);
	}

	private renderLogicalLines(
		logicalLines: string[],
		contentWidth: number,
		width: number,
	): string[] {
		const wrappedLines: string[] = [];
		for (const line of logicalLines) {
			if (isImageLine(line)) {
				wrappedLines.push(line);
				continue;
			}
			wrappedLines.push(...wrapTextWithAnsi(line, contentWidth));
		}

		const leftMargin = " ".repeat(this.paddingX);
		const rightMargin = " ".repeat(this.paddingX);
		const bgFn = this.defaultTextStyle?.bgColor;
		return wrappedLines.map((line) => {
			if (isImageLine(line)) return line;
			const lineWithMargins = leftMargin + line + rightMargin;
			if (bgFn) return applyBackgroundToLine(lineWithMargins, width, bgFn);
			return lineWithMargins + " ".repeat(Math.max(0, width - visibleWidth(lineWithMargins)));
		});
	}

	/**
	 * Apply default text style to a string.
	 * This is the base styling applied to all text content.
	 * NOTE: Background color is NOT applied here - it's applied at the padding stage
	 * to ensure it extends to the full line width.
	 */
	private applyDefaultStyle(text: string): string {
		if (!this.defaultTextStyle) {
			return text;
		}

		let styled = text;

		// Apply foreground color (NOT background - that's applied at padding stage)
		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		// Apply text decorations using this.theme
		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		return styled;
	}

	private getDefaultStylePrefix(): string {
		if (!this.defaultTextStyle) {
			return "";
		}

		if (this.defaultStylePrefix !== undefined) {
			return this.defaultStylePrefix;
		}

		const sentinel = "\u0000";
		const styled = this.applyDefaultStyle(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.defaultStylePrefix;
	}

	private getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	private getDefaultInlineStyleContext(): InlineStyleContext {
		return {
			applyText: (text: string) => this.applyDefaultStyle(text),
			stylePrefix: this.getDefaultStylePrefix(),
		};
	}

	private renderToken(
		token: Token,
		width: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];

		switch (token.type) {
			case "heading": {
				const headingLevel = token.depth;
				const headingPrefix = `${"#".repeat(headingLevel)} `;

				// Build a heading-specific style context so inline tokens (codespan, bold, etc.)
				// restore heading styling after their own ANSI resets instead of falling back to
				// the default text style.
				let headingStyleFn: (text: string) => string;
				if (headingLevel === 1) {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(this.theme.underline(text)));
				} else {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(text));
				}

				const headingStyleContext: InlineStyleContext = {
					applyText: headingStyleFn,
					stylePrefix: this.getStylePrefix(headingStyleFn),
				};

				const headingText = this.renderInlineTokens(token.tokens || [], headingStyleContext);
				const styledHeading = headingLevel >= 3 ? headingStyleFn(headingPrefix) + headingText : headingText;
				lines.push(styledHeading);
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after headings (unless space token follows)
				}
				break;
			}

			case "paragraph": {
				const paragraphText = this.renderInlineTokens(token.tokens || [], styleContext);
				lines.push(paragraphText);
				// Don't add spacing if next token is space or list
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "text":
				lines.push(this.renderInlineTokens([token], styleContext));
				break;

			case "code": {
				const indent = this.theme.codeBlockIndent ?? "  ";
				const codeLines = token.text.split("\n");
				const previewLines = this.codeBlockPreviewLineCount(codeLines.length);
				lines.push(this.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`));
				if (this.theme.highlightCode) {
					const highlightedLines = this.theme.highlightCode(token.text, token.lang);
					for (const hlLine of highlightedLines.slice(0, previewLines ?? highlightedLines.length)) {
						lines.push(`${indent}${hlLine}`);
					}
				} else {
					for (const codeLine of codeLines.slice(0, previewLines ?? codeLines.length)) {
						lines.push(`${indent}${this.theme.codeBlock(codeLine)}`);
					}
				}
				if (previewLines !== undefined && codeLines.length > previewLines) {
					lines.push(`${indent}${this.theme.codeBlockBorder(`... ${codeLines.length - previewLines} more lines`)}`);
				}
				lines.push(this.theme.codeBlockBorder("```"));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after code blocks (unless space token follows)
				}
				break;
			}

			case "list": {
				const listLines = this.renderList(token as Tokens.List, 0, width, styleContext);
				lines.push(...listLines);
				// Don't add spacing after lists if a space token follows
				// (the space token will handle it)
				break;
			}

			case "table": {
				const tableLines = this.renderTable(token as Tokens.Table, width, nextTokenType, styleContext);
				lines.push(...tableLines);
				break;
			}

			case "blockquote": {
				const quoteStyle = (text: string) => this.theme.quote(this.theme.italic(text));
				const quoteStylePrefix = this.getStylePrefix(quoteStyle);
				const applyQuoteStyle = (line: string): string => {
					if (!quoteStylePrefix) {
						return quoteStyle(line);
					}
					const lineWithReappliedStyle = line.replaceAll(ANSI_FULL_RESET, `\x1b[0m${quoteStylePrefix}`);
					return quoteStyle(lineWithReappliedStyle);
				};

				// Calculate available width for quote content (subtract border "│ " = 2 chars)
				const quoteContentWidth = Math.max(1, width - 2);

				// Blockquotes contain block-level tokens (paragraph, list, code, etc.), so render
				// children with renderToken() instead of renderInlineTokens().
				// Default message style should not apply inside blockquotes.
				const quoteInlineStyleContext: InlineStyleContext = {
					applyText: (text: string) => text,
					stylePrefix: quoteStylePrefix,
				};
				const quoteTokens = token.tokens || [];
				const renderedQuoteLines: string[] = [];
				for (let i = 0; i < quoteTokens.length; i++) {
					const quoteToken = quoteTokens[i];
					const nextQuoteToken = quoteTokens[i + 1];
					renderedQuoteLines.push(
						...this.renderToken(quoteToken, quoteContentWidth, nextQuoteToken?.type, quoteInlineStyleContext),
					);
				}

				// Avoid rendering an extra empty quote line before the outer blockquote spacing.
				while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
					renderedQuoteLines.pop();
				}

				for (const quoteLine of renderedQuoteLines) {
					const styledLine = applyQuoteStyle(quoteLine);
					const wrappedLines = wrapTextWithAnsi(styledLine, quoteContentWidth);
					for (const wrappedLine of wrappedLines) {
						lines.push(this.theme.quoteBorder(`${this.theme.glyphs?.vertical ?? "│"} `) + wrappedLine);
					}
				}
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after blockquotes (unless space token follows)
				}
				break;
			}

			case "hr":
				lines.push(this.theme.hr((this.theme.glyphs?.horizontal ?? "─").repeat(Math.min(width, 80))));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after horizontal rules (unless space token follows)
				}
				break;

			case "html":
				// Render HTML as plain text (escaped for terminal)
				if ("raw" in token && typeof token.raw === "string") {
					lines.push(this.applyDefaultStyle(token.raw.trim()));
				}
				break;

			case "space":
				// Space tokens represent blank lines in markdown
				lines.push("");
				break;

			default:
				// Handle any other token types as plain text
				if ("text" in token && typeof token.text === "string") {
					lines.push(token.text);
				}
		}

		return lines;
	}

	private codeBlockPreviewLineCount(totalLines: number): number | undefined {
		const configured = this.options.codeBlockPreviewLines;
		if (configured === undefined || configured <= 0 || totalLines <= configured) {
			return undefined;
		}
		return configured;
	}

	private renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
		let result = "";
		const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;
		const applyTextWithNewlines = (text: string): string => {
			const segments: string[] = text.split("\n");
			return segments.map((segment: string) => applyText(segment)).join("\n");
		};

		for (const token of tokens) {
			switch (token.type) {
				case "text":
					// Text tokens in list items can have nested tokens for inline formatting
					if (token.tokens && token.tokens.length > 0) {
						result += this.renderInlineTokens(token.tokens, resolvedStyleContext);
					} else {
						result += applyTextWithNewlines(token.text);
					}
					break;

				case "paragraph":
					// Paragraph tokens contain nested inline tokens
					result += this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					break;

				case "strong": {
					const boldContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.bold(boldContent) + stylePrefix;
					break;
				}

				case "em": {
					const italicContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.italic(italicContent) + stylePrefix;
					break;
				}

				case "codespan":
					result += this.theme.code(token.text) + stylePrefix;
					break;

				case "link": {
					const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					const styledLink = this.theme.link(this.theme.underline(linkText));
					if (getCapabilities().hyperlinks) {
						// OSC 8: render as a clickable hyperlink. The URL is not printed inline,
						// so we always show only the link text regardless of whether it matches href.
						result += hyperlink(styledLink, token.href) + stylePrefix;
					} else {
						// Fallback: print URL in parentheses when text differs from href.
						// Compare raw token.text (not styled) against href for the equality check.
						// For mailto: links strip the prefix (autolinked emails use text="foo@bar.com"
						// but href="mailto:foo@bar.com").
						const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
						if (token.text === token.href || token.text === hrefForComparison) {
							result += styledLink + stylePrefix;
						} else {
							result += styledLink + this.theme.linkUrl(` (${token.href})`) + stylePrefix;
						}
					}
					break;
				}

				case "br":
					result += "\n";
					break;

				case "del": {
					const delContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.strikethrough(delContent) + stylePrefix;
					break;
				}

				case "html":
					// Render inline HTML as plain text
					if ("raw" in token && typeof token.raw === "string") {
						result += applyTextWithNewlines(token.raw);
					}
					break;

				default:
					// Handle any other inline token types as plain text
					if ("text" in token && typeof token.text === "string") {
						result += applyTextWithNewlines(token.text);
					}
			}
		}

		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}

		return result;
	}

	private getOrderedListMarker(item: Tokens.ListItem): string | undefined {
		const match = /^(?: {0,3})(\d{1,9}[.)])[ \t]+/.exec(item.raw);
		return match ? `${match[1]} ` : undefined;
	}

	/**
	 * Render a list with proper nesting support
	 */
	private renderList(token: Tokens.List, depth: number, width: number, styleContext?: InlineStyleContext): string[] {
		const lines: string[] = [];
		for (let i = 0; i < token.items.length; i++) {
			lines.push(...this.renderListItem(token, token.items[i]!, i, depth, width, styleContext));
		}

		return lines;
	}

	private renderListItem(
		list: Tokens.List,
		item: Tokens.ListItem,
		index: number,
		depth: number,
		width: number,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];
		const indent = "    ".repeat(depth);
		const startNumber = typeof list.start === "number" ? list.start : 1;
		const bullet = list.ordered
			? this.options.preserveOrderedListMarkers
				? (this.getOrderedListMarker(item) ?? `${startNumber + index}. `)
				: `${startNumber + index}. `
			: "- ";
		const taskMarker = item.task ? `[${item.checked ? "x" : " "}] ` : "";
		const marker = bullet + taskMarker;
		const firstPrefix = indent + this.theme.listBullet(marker);
		const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
		const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
		let renderedAnyLine = false;

		for (const itemToken of item.tokens) {
			if (itemToken.type === "list") {
				lines.push(...this.renderList(itemToken as Tokens.List, depth + 1, width, styleContext));
				renderedAnyLine = true;
				continue;
			}

			const itemLines = this.renderToken(itemToken, itemWidth, undefined, styleContext);
			for (const line of itemLines) {
				for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
					const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
					lines.push(linePrefix + wrappedLine);
					renderedAnyLine = true;
				}
			}
		}

		if (!renderedAnyLine) lines.push(firstPrefix);
		return lines;
	}

	/**
	 * Get the visible width of the longest word in a string.
	 */
	private getLongestWordWidth(text: string, maxWidth?: number): number {
		const words = text.split(/\s+/).filter((word) => word.length > 0);
		let longest = 0;
		for (const word of words) {
			longest = Math.max(longest, visibleWidth(word));
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	/**
	 * Wrap a table cell to fit into a column.
	 *
	 * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
	 * consistently with the rest of the renderer.
	 */
	private wrapCellText(text: string, maxWidth: number): string[] {
		return wrapTextWithAnsi(text, Math.max(1, maxWidth));
	}

	/**
	 * Render a table with width-aware cell wrapping.
	 * Cells that don't fit are wrapped to multiple lines.
	 */
	private renderTable(
		token: Tokens.Table,
		availableWidth: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		if (token.header.length === 0) return [];
		const layout = this.tableColumnLayout(token, availableWidth, styleContext);
		if (!layout) {
			// Too narrow to render a stable table. Fall back to raw markdown.
			const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
			if (nextTokenType && nextTokenType !== "space") {
				fallbackLines.push("");
			}
			return fallbackLines;
		}
		const rendered = this.renderTableLines(token, layout.columnWidths, styleContext);
		if (nextTokenType && nextTokenType !== "space") rendered.lines.push("");
		return rendered.lines;
	}

	private tableColumnLayout(
		token: Tokens.Table,
		availableWidth: number,
		styleContext?: InlineStyleContext,
	): TableColumnLayout | null {
		const numCols = token.header.length;
		const borderOverhead = 3 * numCols + 1;
		if (numCols === 0 || availableWidth - borderOverhead < numCols) return null;

		const headerMetrics = this.tableRowMetrics(token.header, numCols, styleContext);
		const naturalWidths = [...headerMetrics.naturalWidths];
		const minWordWidths = [...headerMetrics.minWordWidths];
		for (const row of token.rows) {
			const metrics = this.tableRowMetrics(row, numCols, styleContext);
			for (let index = 0; index < numCols; index += 1) {
				naturalWidths[index] = Math.max(naturalWidths[index] ?? 0, metrics.naturalWidths[index] ?? 0);
				minWordWidths[index] = Math.max(minWordWidths[index] ?? 1, metrics.minWordWidths[index] ?? 1);
			}
		}
		const columnWidths = this.resolveTableColumnWidths(naturalWidths, minWordWidths, availableWidth);
		return columnWidths ? { naturalWidths, minWordWidths, columnWidths } : null;
	}

	private tableRowMetrics(
		row: readonly Tokens.TableCell[],
		numCols: number,
		styleContext?: InlineStyleContext,
	): TableRowMetrics {
		const maxUnbrokenWordWidth = 30;
		const naturalWidths = new Array<number>(numCols).fill(0);
		const minWordWidths = new Array<number>(numCols).fill(1);
		for (let index = 0; index < Math.min(numCols, row.length); index += 1) {
			const text = this.renderInlineTokens(row[index]!.tokens || [], styleContext);
			naturalWidths[index] = visibleWidth(text);
			minWordWidths[index] = Math.max(1, this.getLongestWordWidth(text, maxUnbrokenWordWidth));
		}
		return { naturalWidths, minWordWidths };
	}

	private resolveTableColumnWidths(
		naturalWidths: readonly number[],
		minWordWidths: readonly number[],
		availableWidth: number,
	): number[] | null {
		const numCols = naturalWidths.length;
		const borderOverhead = 3 * numCols + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (numCols === 0 || availableForCells < numCols) return null;
		let minColumnWidths = [...minWordWidths];
		let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

		if (minCellsWidth > availableForCells) {
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
				const growth = minWordWidths.map((width) => {
					const weight = Math.max(0, width - 1);
					return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				});

				for (let i = 0; i < numCols; i++) {
					minColumnWidths[i] += growth[i] ?? 0;
				}

				const allocated = growth.reduce((total, width) => total + width, 0);
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					minColumnWidths[i]++;
					leftover--;
				}
			}

			minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
		}

		// Calculate column widths that fit within available width
		const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
		let columnWidths: number[];

		if (totalNaturalWidth <= availableWidth) {
			// Everything fits naturally
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]!));
		} else {
			// Need to shrink columns to fit
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				return total + Math.max(0, width - minColumnWidths[index]!);
			}, 0);
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = minColumnWidths.map((minWidth, index) => {
				const naturalWidth = naturalWidths[index]!;
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				let grow = 0;
				if (totalGrowPotential > 0) {
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				return minWidth + grow;
			});

			// Adjust for rounding errors - distribute remaining space
			const allocated = columnWidths.reduce((a, b) => a + b, 0);
			let remaining = availableForCells - allocated;
			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i++) {
					if (columnWidths[i]! < naturalWidths[i]!) {
						columnWidths[i]++;
						remaining--;
						grew = true;
					}
				}
				if (!grew) {
					break;
				}
			}
		}
		return columnWidths;
	}

	private renderTableLines(
		token: Tokens.Table,
		columnWidths: readonly number[],
		styleContext?: InlineStyleContext,
	): RenderedTableLines {
		const lines: string[] = [];
		const rowBoundaryStarts: number[] = [];
		const glyphs = markdownTableGlyphs(this.theme);
		const topBorderCells = columnWidths.map((w) => glyphs.horizontal.repeat(w));
		lines.push(`${glyphs.topLeft}${glyphs.horizontal}${topBorderCells.join(`${glyphs.horizontal}${glyphs.teeTop}${glyphs.horizontal}`)}${glyphs.horizontal}${glyphs.topRight}`);
		lines.push(...this.renderTableRow(token.header, columnWidths, true, styleContext));

		const separatorLine = this.tableSeparatorLine(columnWidths);
		if (token.rows.length === 0) lines.push(separatorLine);
		for (const row of token.rows) {
			rowBoundaryStarts.push(lines.length);
			lines.push(separatorLine);
			lines.push(...this.renderTableRow(row, columnWidths, false, styleContext));
		}

		const bottomLineStart = lines.length;
		const bottomBorderCells = columnWidths.map((w) => glyphs.horizontal.repeat(w));
		lines.push(`${glyphs.bottomLeft}${glyphs.horizontal}${bottomBorderCells.join(`${glyphs.horizontal}${glyphs.teeBottom}${glyphs.horizontal}`)}${glyphs.horizontal}${glyphs.bottomRight}`);
		return { lines, rowBoundaryStarts, bottomLineStart };
	}

	private renderTableSuffix(
		rows: readonly Tokens.TableCell[][],
		columnWidths: readonly number[],
	): RenderedTableLines {
		const lines: string[] = [];
		const rowBoundaryStarts: number[] = [];
		const separatorLine = this.tableSeparatorLine(columnWidths);
		for (const row of rows) {
			rowBoundaryStarts.push(lines.length);
			lines.push(separatorLine);
			lines.push(...this.renderTableRow(row, columnWidths, false));
		}
		const bottomLineStart = lines.length;
		const glyphs = markdownTableGlyphs(this.theme);
		const bottomBorderCells = columnWidths.map((width) => glyphs.horizontal.repeat(width));
		lines.push(`${glyphs.bottomLeft}${glyphs.horizontal}${bottomBorderCells.join(`${glyphs.horizontal}${glyphs.teeBottom}${glyphs.horizontal}`)}${glyphs.horizontal}${glyphs.bottomRight}`);
		return { lines, rowBoundaryStarts, bottomLineStart };
	}

	private renderTableRow(
		row: readonly Tokens.TableCell[],
		columnWidths: readonly number[],
		header: boolean,
		styleContext?: InlineStyleContext,
	): string[] {
		const cellLines = row.map((cell, index) => {
			const text = this.renderInlineTokens(cell.tokens || [], styleContext);
			return this.wrapCellText(text, columnWidths[index]!);
		});
		const lineCount = Math.max(...cellLines.map((cell) => cell.length));
		const lines: string[] = [];
		for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
			const rowParts = cellLines.map((wrapped, columnIndex) => {
				const text = wrapped[lineIndex] || "";
				const padded = text + " ".repeat(Math.max(0, columnWidths[columnIndex]! - visibleWidth(text)));
				return header ? this.theme.bold(padded) : padded;
			});
			const vertical = this.theme.glyphs?.vertical ?? "│";
			lines.push(`${vertical} ${rowParts.join(` ${vertical} `)} ${vertical}`);
		}
		return lines;
	}

	private tableSeparatorLine(columnWidths: readonly number[]): string {
		const glyphs = markdownTableGlyphs(this.theme);
		const cells = columnWidths.map((width) => glyphs.horizontal.repeat(width));
		return `${glyphs.teeLeft}${glyphs.horizontal}${cells.join(`${glyphs.horizontal}${glyphs.cross}${glyphs.horizontal}`)}${glyphs.horizontal}${glyphs.teeRight}`;
	}
}
