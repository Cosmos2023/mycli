import { truncateToWidth, visibleWidth } from "../../tui-core/utils.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme } from "../../theme/theme.ts";

/**
 * Shared geometry for command and selector list panels: a title with a right-aligned count, one dim
 * rule, aligned columns, and one hint row. Every panel reuses it so the surfaces look alike.
 */
export function listPanelHeader(title: string, meta: string | undefined, width: number): string {
	const left = theme.bold(singleLine(title));
	const right = meta ? theme.fg("muted", singleLine(meta)) : "";
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right) - 2);
	return truncateToWidth(`  ${left}${" ".repeat(gap)}${right}`, width, "", true);
}

export function listPanelRule(width: number): string {
	return theme.fg("border", uiGlyphs().horizontal.repeat(Math.max(1, Math.floor(width))));
}

/** Column widths shared by the header row and every data row. */
export function listPanelWidths(
	rows: readonly { readonly label: string; readonly values: readonly string[]; readonly status?: string }[],
	maxColumnWidth: number,
): number[] {
	const widths: number[] = [];
	for (const row of rows) {
		const cells = [row.label, ...row.values, ...(row.status ? [row.status] : [])];
		cells.forEach((cell, index) => {
			widths[index] = Math.max(widths[index] ?? 0, visibleWidth(singleLine(cell)));
		});
	}
	return widths.map((value) => Math.max(1, Math.min(value, maxColumnWidth)));
}

export function listPanelColumns(
	columns: readonly string[] | undefined,
	widths: readonly number[],
	width: number,
): string | undefined {
	if (!columns || columns.length === 0) return undefined;
	const cells = columns.map((column, index) => padCell(singleLine(column), widths[index] ?? 0));
	return truncateToWidth(`  ${theme.fg("dim", cells.join("  ").trimEnd())}`, width, "...");
}

/** One row: selector glyph, aligned cells, optional dim detail on the same line. */
export function listPanelRow(input: {
	readonly selected: boolean;
	readonly label: string;
	readonly values: readonly string[];
	readonly status?: string;
	readonly widths: readonly number[];
	readonly detail?: string;
	readonly width: number;
}): string {
	const cells = [input.label, ...input.values, ...(input.status ? [input.status] : [])];
	const padded = cells.map((cell, index) => padCell(singleLine(cell), input.widths[index] ?? 0));
	const label = padded[0] ?? "";
	const rest = padded.slice(1).join("  ").trimEnd();
	const prefix = input.selected ? `${uiGlyphs().selector} ` : "  ";
	const body = rest ? `${prefix}${label}  ${theme.fg("muted", rest)}` : `${prefix}${label}`;
	const text = input.selected ? theme.fg("accent", body) : body;
	const detail = input.detail ? `  ${theme.fg("dim", singleLine(input.detail))}` : "";
	return truncateToWidth(`${text}${detail}`, input.width, "...");
}

export function listPanelFooter(hints: readonly string[], width: number): string {
	// Keep the trailing hints (the way out) when the row is too narrow for all of them.
	const kept: string[] = [];
	for (const hint of [...hints].filter(Boolean).reverse()) {
		const candidate = [hint, ...kept].join("  ");
		if (kept.length > 0 && visibleWidth(`  ${candidate}`) > width) continue;
		kept.unshift(hint);
	}
	return truncateToWidth(`  ${kept.join("  ")}`, width, "...", true);
}

/** Keep the prompt caret, but replace its empty padding with a dim placeholder. */
export function listPanelPrompt(
	rendered: string,
	hasValue: boolean,
	placeholder: string,
	width: number,
): string {
	if (hasValue) return rendered;
	const trimmed = rendered.replace(/\u001b\[0m$/u, "").replace(/ +$/u, "");
	return truncateToWidth(`${trimmed}${theme.fg("dim", placeholder)}`, width, "");
}

/** Panels render single-line cells, so control characters and newlines never reach the layout. */
export function singleLine(value: string): string {
	return value.replace(/[\r\n\t]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function padCell(value: string, width: number): string {
	const current = visibleWidth(value);
	return current >= width ? value : `${value}${" ".repeat(width - current)}`;
}
