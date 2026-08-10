import { Marked, type Token, Tokenizer, type Tokens } from "marked";
import { getCapabilities, hyperlink, isImageLine } from "../terminal-image.ts";
import type { Component, TailRenderResult } from "../tui.ts";
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.ts";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

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
	paragraph?: RenderedPlainParagraphCache;
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
	sourceToken: Tokens.Paragraph;
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
	private appendedTokenSources = new WeakMap<Token, Token>();
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
		this.appendedTokenSources = new WeakMap();
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

		if (token.type === "paragraph") {
			const paragraphToken = token as Tokens.Paragraph;
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
			const plainText = this.retainablePlainParagraphText(paragraphToken, nextType);
			return plainText === null
				? entry
				: {
					...entry,
					paragraph: { text: plainText, sourceToken: paragraphToken },
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

	private retainablePlainParagraphText(
		token: Tokens.Paragraph,
		nextType: string | undefined,
	): string | null {
		if (this.defaultTextStyle !== undefined || nextType !== undefined || token.text.includes("\n")) {
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
		paragraph.sourceToken = token;
		return cached;
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
					const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
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
						lines.push(this.theme.quoteBorder("│ ") + wrappedLine);
					}
				}
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after blockquotes (unless space token follows)
				}
				break;
			}

			case "hr":
				lines.push(this.theme.hr("─".repeat(Math.min(width, 80))));
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
		const indent = "    ".repeat(depth);
		// Use the list's start property (defaults to 1 for ordered lists)
		const startNumber = typeof token.start === "number" ? token.start : 1;

		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i];
			const bullet = token.ordered
				? this.options.preserveOrderedListMarkers
					? (this.getOrderedListMarker(item) ?? `${startNumber + i}. `)
					: `${startNumber + i}. `
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

			if (!renderedAnyLine) {
				lines.push(firstPrefix);
			}
		}

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
		const lines: string[] = [];
		const numCols = token.header.length;

		if (numCols === 0) {
			return lines;
		}

		// Calculate border overhead: "│ " + (n-1) * " │ " + " │"
		// = 2 + (n-1) * 3 + 2 = 3n + 1
		const borderOverhead = 3 * numCols + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < numCols) {
			// Too narrow to render a stable table. Fall back to raw markdown.
			const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
			if (nextTokenType && nextTokenType !== "space") {
				fallbackLines.push("");
			}
			return fallbackLines;
		}

		const maxUnbrokenWordWidth = 30;

		// Calculate natural column widths (what each column needs without constraints)
		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		for (let i = 0; i < numCols; i++) {
			const headerText = this.renderInlineTokens(token.header[i].tokens || [], styleContext);
			naturalWidths[i] = visibleWidth(headerText);
			minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		for (const row of token.rows) {
			for (let i = 0; i < row.length; i++) {
				const cellText = this.renderInlineTokens(row[i].tokens || [], styleContext);
				naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
				minWordWidths[i] = Math.max(
					minWordWidths[i] || 1,
					this.getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}

		let minColumnWidths = minWordWidths;
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
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
		} else {
			// Need to shrink columns to fit
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				return total + Math.max(0, width - minColumnWidths[index]);
			}, 0);
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = minColumnWidths.map((minWidth, index) => {
				const naturalWidth = naturalWidths[index];
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
					if (columnWidths[i] < naturalWidths[i]) {
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

		// Render top border
		const topBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`┌─${topBorderCells.join("─┬─")}─┐`);

		// Render header with wrapping
		const headerCellLines: string[][] = token.header.map((cell, i) => {
			const text = this.renderInlineTokens(cell.tokens || [], styleContext);
			return this.wrapCellText(text, columnWidths[i]);
		});
		const headerLineCount = Math.max(...headerCellLines.map((c) => c.length));

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			const rowParts = headerCellLines.map((cellLines, colIdx) => {
				const text = cellLines[lineIdx] || "";
				const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				return this.theme.bold(padded);
			});
			lines.push(`│ ${rowParts.join(" │ ")} │`);
		}

		// Render separator
		const separatorCells = columnWidths.map((w) => "─".repeat(w));
		const separatorLine = `├─${separatorCells.join("─┼─")}─┤`;
		lines.push(separatorLine);

		// Render rows with wrapping
		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			const row = token.rows[rowIndex];
			const rowCellLines: string[][] = row.map((cell, i) => {
				const text = this.renderInlineTokens(cell.tokens || [], styleContext);
				return this.wrapCellText(text, columnWidths[i]);
			});
			const rowLineCount = Math.max(...rowCellLines.map((c) => c.length));

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				const rowParts = rowCellLines.map((cellLines, colIdx) => {
					const text = cellLines[lineIdx] || "";
					return text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				});
				lines.push(`│ ${rowParts.join(" │ ")} │`);
			}

			if (rowIndex < token.rows.length - 1) {
				lines.push(separatorLine);
			}
		}

		// Render bottom border
		const bottomBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`└─${bottomBorderCells.join("─┴─")}─┘`);

		if (nextTokenType && nextTokenType !== "space") {
			lines.push(""); // Add spacing after table
		}
		return lines;
	}
}
