import type { Component } from "../tui-core/tui.ts";
import { Container } from "../tui-core/tui.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../tui-core/utils.ts";
import type {
	MycliShellCommandField,
	MycliShellCommandResult,
	MycliShellCommandRow,
} from "../model.ts";
import type { ThemeColor } from "../theme/theme.ts";
import { uiGlyphs } from "../theme/terminal-style.ts";
import { theme } from "../theme/theme.ts";

const STATUS_MAX_WIDTH = 76;
const FOLDED_ROW_LIMIT = 8;

export class CommandResultComponent extends Container implements Component {
	constructor(private result: MycliShellCommandResult) {
		super();
	}

	updateResult(result: MycliShellCommandResult): void {
		this.result = result;
		this.invalidate();
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		let body: string[];
		switch (this.result.display.kind) {
			case "status":
				body = this.renderStatus(safeWidth);
				break;
			case "diagnostic":
				body = this.renderDiagnostic(safeWidth);
				break;
			case "list":
				body = this.renderList(safeWidth);
				break;
			case "notice":
				body = this.renderNotice(safeWidth);
				break;
			case "error":
				body = this.renderError(safeWidth);
				break;
			case "preformatted":
				body = this.renderPreformatted(safeWidth);
				break;
		}
		return this.withCommand(body, safeWidth);
	}

	private renderStatus(width: number): string[] {
		return this.renderCard(width, this.result.display.title);
	}

	private renderDiagnostic(width: number): string[] {
		return this.renderCard(width, this.result.display.title);
	}

	private renderCard(width: number, title: string): string[] {
		if (width < 8) {
			return [this.fit(this.result.display.summary ?? title, width)];
		}
		const boxWidth = Math.min(STATUS_MAX_WIDTH, width);
		const contentWidth = boxWidth - 6;
		const borderWidth = boxWidth - 2;
		const glyphs = uiGlyphs();
		const lines = [theme.fg("border", `${glyphs.topLeft}${glyphs.horizontal.repeat(borderWidth)}${glyphs.topRight}`)];
		const cardTitle = this.result.display.summary
			? `${title}  ${this.result.display.summary}`
			: title;
		lines.push(this.statusLine(theme.bold(cardTitle), contentWidth));
		this.appendCardFields(lines, this.result.display.fields, contentWidth);
		for (const section of this.result.display.sections) {
			if (lines.length > 2) {
				lines.push(this.statusLine("", contentWidth));
			}
			lines.push(this.statusLine(theme.fg("muted", theme.bold(sanitize(section.title))), contentWidth));
			this.appendCardFields(lines, section.fields, contentWidth);
			for (const row of section.rows) {
				const value = [...row.values, ...(row.detail ? [row.detail] : [])].join("  ");
				this.appendCardFields(
					lines,
					[{ label: row.label, value, tone: row.status }],
					contentWidth,
				);
			}
		}
		lines.push(theme.fg("border", `${glyphs.bottomLeft}${glyphs.horizontal.repeat(borderWidth)}${glyphs.bottomRight}`));
		return lines;
	}

	private appendCardFields(lines: string[], fields: MycliShellCommandField[], contentWidth: number): void {
		const labelWidth = this.labelWidth(fields, Math.max(1, Math.floor(contentWidth / 2)));
		for (const field of fields) {
			const label = padVisible(sanitize(field.label), labelWidth);
			lines.push(
				this.statusLine(
					`${theme.fg("muted", label)}  ${theme.fg(this.fieldColor(field), sanitize(field.value))}`,
					contentWidth,
				),
			);
		}
	}

	private statusLine(text: string, contentWidth: number): string {
		const content = truncateToWidth(text, contentWidth, theme.fg("dim", "..."), true);
		return `${theme.fg("border", uiGlyphs().vertical)}  ${content}  ${theme.fg("border", uiGlyphs().vertical)}`;
	}

	private renderList(width: number): string[] {
		const display = this.result.display;
		const title = display.summary
			? `${theme.fg("accent", theme.bold(display.title))}  ${theme.fg("dim", display.summary)}`
			: theme.fg("accent", theme.bold(display.title));
		const lines = [this.fit(title, width)];
		if (display.rows.length === 0) {
			lines.push(this.fit(theme.fg("muted", "  No items."), width));
			return lines;
		}
		const visibleRows = this.result.folded
			? display.rows.slice(0, FOLDED_ROW_LIMIT)
			: display.rows;
		const columnWidths = this.columnWidths(visibleRows);
		for (const row of visibleRows) {
			const values = [row.label, ...row.values].map(sanitize);
			const columns = values.map((value, index) => {
				const padded = padVisible(value, columnWidths[index] ?? visibleWidth(value));
				return index === 0 ? theme.fg("text", padded) : theme.fg("muted", padded);
			});
			const detail = row.detail ? `  ${theme.fg("dim", sanitize(row.detail))}` : "";
			lines.push(this.fit(`  ${columns.join("  ")}${detail}`, width));
		}
		const hiddenRows = display.rows.length - visibleRows.length + display.omittedRows;
		if (hiddenRows > 0) {
			lines.push(this.fit(theme.fg("dim", `  ... ${hiddenRows} more`), width));
		}
		return lines;
	}

	private renderNotice(width: number): string[] {
		const display = this.result.display;
		const marker = display.severity === "success" ? uiGlyphs().success : display.severity === "info" ? uiGlyphs().bullet : "!";
		const color: ThemeColor = display.severity === "success"
			? "success"
			: display.severity === "error"
				? "error"
				: display.severity === "warning"
					? "warning"
					: "accent";
		const prefix = `${theme.fg(color, marker)} `;
		const continuation = " ".repeat(visibleWidth(prefix));
		const contentWidth = Math.max(1, width - visibleWidth(prefix));
		return wrapTextWithAnsi(display.summary ?? display.title, contentWidth).map((line, index) =>
			this.fit(`${index === 0 ? prefix : continuation}${line}`, width));
	}

	private renderError(width: number): string[] {
		const display = this.result.display;
		const lines = [this.fit(`${theme.fg("error", "!")} ${display.summary ?? display.title}`, width)];
		if (display.usage) {
			lines.push(this.fit(theme.fg("muted", `  Usage: ${display.usage.replace(/^Usage:\s*/, "")}`), width));
		}
		if (display.suggestions.length > 0) {
			lines.push(this.fit(theme.fg("muted", `  Did you mean: ${display.suggestions.join(", ")}`), width));
		}
		return lines;
	}

	private renderPreformatted(width: number): string[] {
		const display = this.result.display;
		const text = display.preformatted ?? (this.result.fallbackLines.join("\n") || display.title);
		const lines = text.split(/\r?\n/).map((line) => this.fit(line, width));
		if (display.omittedChars > 0 && !text.includes("chars omitted")) {
			lines.push(this.fit(theme.fg("dim", `... ${display.omittedChars} chars omitted ...`), width));
		}
		return lines;
	}

	private fieldColor(field: MycliShellCommandField): ThemeColor {
		return field.tone === "success" || field.tone === "warning" || field.tone === "error"
			? field.tone
			: field.tone === "accent"
				? "accent"
				: "text";
	}

	private labelWidth(fields: MycliShellCommandField[], limit: number): number {
		return Math.min(limit, Math.max(0, ...fields.map((field) => visibleWidth(sanitize(field.label)))));
	}

	private columnWidths(rows: MycliShellCommandRow[]): number[] {
		const widths: number[] = [];
		for (const row of rows) {
			for (const [index, value] of [row.label, ...row.values].entries()) {
				widths[index] = Math.max(widths[index] ?? 0, visibleWidth(sanitize(value)));
			}
		}
		return widths;
	}

	private fit(text: string, width: number): string {
		return truncateToWidth(text, width, theme.fg("dim", "..."));
	}

	private withCommand(body: string[], width: number): string[] {
		const command = this.fit(theme.fg("accent", this.result.display.command), width);
		const separated = this.result.display.kind === "status" ||
			this.result.display.kind === "diagnostic" ||
			this.result.display.kind === "list" ||
			this.result.display.kind === "preformatted";
		return separated ? ["", command, "", ...body] : ["", command, ...body];
	}
}

function sanitize(value: string): string {
	return value.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim();
}

function padVisible(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}
