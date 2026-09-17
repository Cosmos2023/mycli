import { stripVTControlCharacters } from "node:util";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme } from "../../theme/theme.ts";
import type { Component } from "../../tui-core/tui.ts";
import { truncateToWidth, visibleWidth } from "../../tui-core/utils.ts";

export function sanitizeStatusText(text: string): string {
	return stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f\s]+/gu, " ").trim();
}

export function joinStatusParts(parts: readonly string[]): string {
	return parts.filter((part) => visibleWidth(part) > 0).join(theme.fg("dim", ` ${uiGlyphs().separator} `));
}

/** Match the editor's inset and keep clear of the terminal's final column. */
export function statusLineWidth(width: number): number {
	return Math.max(1, width - (width >= 3 ? 3 : 1));
}

export function insetStatusLine(text: string, width: number): string {
	return `${width >= 3 ? " " : ""}${truncateToWidth(text, statusLineWidth(width), uiGlyphs().ellipsis)}`;
}

/** Callers choose priorities; reserve the right column before truncating the left. */
export function alignStatusColumns(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(right) === 0) return truncateToWidth(left, width, uiGlyphs().ellipsis);
	const fittedRight = truncateToWidth(right, width, uiGlyphs().ellipsis);
	const leftWidth = Math.max(0, width - visibleWidth(fittedRight) - 2);
	const fittedLeft = truncateToWidth(left, leftWidth, uiGlyphs().ellipsis);
	return `${fittedLeft}${" ".repeat(Math.max(0, width - visibleWidth(fittedLeft) - visibleWidth(fittedRight)))}${fittedRight}`;
}

/** Non-animated activity uses the same bounded row in static and interactive views. */
export class StatusMessageComponent implements Component {
	constructor(private readonly text: string) {}

	invalidate(): void {}

	render(width: number): string[] {
		const text = sanitizeStatusText(this.text);
		return width > 0 && text ? [insetStatusLine(theme.fg("muted", text), width)] : [];
	}
}
