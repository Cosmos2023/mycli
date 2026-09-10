import parseDiff from "parse-diff";

import { applyBackgroundToLine, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../tui-core/utils.ts";
import { theme, type ThemeColor } from "../../theme/theme.ts";
import { highlightDiffCode } from "../shared/syntax-highlight.ts";


type DiffRowKind = "context" | "add" | "remove" | "marker";

export type DiffRenderOptions = {
	width: number;
	indent: number;
	language?: string;
	highlight?: (code: string, language?: string) => string;
};

type ParsedChange = parseDiff.Change;

const OMISSION_PATTERN = /\.\.\.\s+(?:\d+\s+lines\s+\/\s+)?\d+\s+chars\s+omitted\s+\.\.\./;


export function stripDiffHunkHeaders(diff: string): string {
	return diff
		.split(/\r?\n/)
		.filter((line) => !line.startsWith("@@"))
		.join("\n");
}

export function styleCompactDiff(text: string, contextColor: ThemeColor): string {
	return text
		.split("\n")
		.map((line) => {
			if (line.startsWith("+") && !line.startsWith("+++")) {
				return theme.fg("toolDiffAdded", line);
			}
			if (line.startsWith("-") && !line.startsWith("---")) {
				return theme.fg("toolDiffRemoved", line);
			}
			if (line.startsWith("@@")) {
				return theme.fg("accent", line);
			}
			return theme.fg(contextColor, line);
		})
		.join("\n");
}


export function renderUnifiedDiff(diff: string, options: DiffRenderOptions): string[] {
	// Match Text/Markdown and visibleWidth: terminal tabs move the cursor without painting cells.
	const normalizedDiff = diff.replace(/\t/g, "   ");
	const width = Math.max(1, Math.floor(options.width));
	const indent = Math.min(Math.max(0, Math.floor(options.indent)), Math.max(0, width - 3));
	let files: parseDiff.File[];
	try {
		files = parseDiff(normalizedDiff);
	} catch {
		return renderFallback(normalizedDiff, width, indent);
	}
	const chunks = files.flatMap((file) => file.chunks);
	if (chunks.length === 0) return renderFallback(normalizedDiff, width, indent);

	const changes = chunks.flatMap((chunk) => chunk.changes);
	const highlight = options.highlight ?? ((code: string, language?: string) =>
		highlightDiffCode(code, language, changes.length));
	const maxLine = changes.reduce((maximum, change) => {
		if (change.type === "normal") return Math.max(maximum, change.ln1, change.ln2);
		return Math.max(maximum, change.ln);
	}, 1);
	const numberWidth = String(maxLine).length;
	const fullNumberPrefixWidth = indent + numberWidth + 3;
	const showNumbers = width - fullNumberPrefixWidth >= 8;
	const lines: string[] = [];

	for (const chunk of chunks) {
		for (const change of chunk.changes) {
			lines.push(...renderChange(change, {
				...options,
				highlight,
				width,
				indent,
				numberWidth,
				showNumbers,
			}));
		}
	}
	return lines;
}


function renderChange(
	change: ParsedChange,
	options: DiffRenderOptions & { numberWidth: number; showNumbers: boolean },
): string[] {
	if (isMarker(change.content)) {
		return renderMetaRow(change.content.replace(/^[ +\\-]/, ""), options.width, options.indent);
	}
	const kind: DiffRowKind = change.type === "add" ? "add" : change.type === "del" ? "remove" : "context";
	const sign = kind === "add" ? "+" : kind === "remove" ? "-" : " ";
	const lineNumber = change.type === "normal" ? change.ln2 : change.ln;
	const rawCode = change.content.slice(1);
	const code = options.highlight ? options.highlight(rawCode, options.language) : rawCode;
	const number = options.showNumbers ? String(lineNumber).padStart(options.numberWidth) : "";
	const firstPrefix = `${" ".repeat(options.indent)}${number}${options.showNumbers ? " " : ""}${sign} `;
	const continuationPrefix = `${" ".repeat(options.indent)}${options.showNumbers ? " ".repeat(options.numberWidth + 1) : ""}  `;
	const codeWidth = Math.max(1, options.width - visibleWidth(firstPrefix));
	const wrapped = wrapTextWithAnsi(code, codeWidth);
	return wrapped.map((segment, index) => {
		const prefix = index === 0 ? firstPrefix : continuationPrefix;
		const line = truncateToWidth(`${prefix}${segment}`, options.width, "");
		return styleRow(kind, line, options.width);
	});
}


function renderMetaRow(
	text: string,
	width: number,
	indent: number,
): string[] {
	const prefix = " ".repeat(indent);
	const available = Math.max(1, width - indent);
	return wrapTextWithAnsi(text.trim(), available).map((segment) => {
		const line = truncateToWidth(`${prefix}${segment}`, width, "");
		return styleRow("marker", line, width);
	});
}


function renderFallback(diff: string, width: number, indent: number): string[] {
	const prefix = " ".repeat(indent);
	const available = Math.max(1, width - indent);
	const rows = diff.split(/\r?\n/);
	if (rows.at(-1) === "") rows.pop();
	return rows.flatMap((row) =>
		wrapTextWithAnsi(row, available).map((segment) =>
			truncateToWidth(`${prefix}${segment}`, width, ""),
		),
	);
}


function styleRow(kind: DiffRowKind, line: string, width: number): string {
	if (kind === "add") {
		return applyBackgroundToLine(
			theme.fg("toolDiffAdded", line),
			width,
			(text) => theme.bg("toolDiffAddedBg", text),
		);
	}
	if (kind === "remove") {
		return applyBackgroundToLine(
			theme.fg("toolDiffRemoved", line),
			width,
			(text) => theme.bg("toolDiffRemovedBg", text),
		);
	}
	return theme.fg("toolDiffContext", line);
}


function isMarker(content: string): boolean {
	return content.startsWith("\\ No newline at end of file") || OMISSION_PATTERN.test(content);
}
