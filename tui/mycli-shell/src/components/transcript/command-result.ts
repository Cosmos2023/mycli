import type { Component } from "../../tui-core/tui.ts";
import { Container } from "../../tui-core/tui.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../tui-core/utils.ts";
import type {
	MycliShellCommandField,
	MycliShellCommandResult,
} from "../../model.ts";
import type { ThemeColor } from "../../theme/theme.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme } from "../../theme/theme.ts";
import {
	listPanelColumns,
	listPanelHeader,
	listPanelRow,
	listPanelRule,
	listPanelWidths,
} from "../selectors/list-panel.ts";

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

	/**
	 * Codex renders command surfaces as borderless, indented lines so they read as transcript
	 * content instead of a pasted box. Values wrap rather than truncate paths and identifiers.
	 */
	private renderStatus(width: number): string[] {
		return this.renderFields(width);
	}

	private renderDiagnostic(width: number): string[] {
		return this.renderFields(width);
	}

	private renderFields(width: number): string[] {
		const display = this.result.display;
		const indent = "  ";
		const lines: string[] = [];
		const title = sanitize(display.title);
		const summary = display.summary === undefined ? "" : sanitize(display.summary);
		if (title || summary) {
			const heading = title && summary && title !== summary
				? `${theme.fg("accent", theme.bold(title))}  ${theme.fg("dim", summary)}`
				: theme.fg("accent", theme.bold(title || summary));
			lines.push(...this.wrapField(`${indent}${heading}`, indent, width));
		}
		this.appendFields(lines, display.fields, indent, width);
		for (const section of display.sections) {
			lines.push("");
			lines.push(...this.wrapField(`${indent}${theme.fg("muted", theme.bold(sanitize(section.title)))}`, indent, width));
			this.appendFields(lines, section.fields, indent, width);
			for (const row of section.rows) {
				const value = [...row.values, ...(row.detail ? [row.detail] : [])].join("  ");
				this.appendFields(lines, [{ label: row.label, value, tone: row.status }], indent, width);
			}
		}
		return lines.length > 0 ? lines : [this.fit(`${indent}${title}`, width)];
	}

	private appendFields(
		lines: string[],
		fields: MycliShellCommandField[],
		indent: string,
		width: number,
	): void {
		const labelWidth = this.labelWidth(fields, Math.max(1, Math.floor(width / 3)));
		for (const field of fields) {
			const label = padVisible(`${sanitize(field.label)}:`, labelWidth + 1);
			const prefix = `${indent}${theme.fg("muted", label)} `;
			lines.push(...this.wrapField(
				`${prefix}${theme.fg(this.fieldColor(field), sanitize(field.value))}`,
				" ".repeat(visibleWidth(prefix)),
				width,
			));
		}
	}

	/** Wrap a field value instead of truncating it, keeping continuation lines under the value. */
	private wrapField(text: string, continuationIndent: string, width: number): string[] {
		const plain = visibleWidth(text);
		if (plain <= width) return [text];
		return wrapTextWithAnsi(text, Math.max(1, width - visibleWidth(continuationIndent)))
			.map((line, index) => this.fit(index === 0 ? line : `${continuationIndent}${line}`, width));
	}

	private renderList(width: number): string[] {
		const display = this.result.display;
		const visibleRows = this.result.folded
			? display.rows.slice(0, FOLDED_ROW_LIMIT)
			: display.rows;
		const widths = listPanelWidths(visibleRows, Math.max(8, Math.floor(width / 3)));
		const lines = [listPanelHeader(display.title, display.summary, width), listPanelRule(width)];
		const columns = listPanelColumns(display.columns, widths, width);
		if (columns) lines.push(columns);
		if (display.rows.length === 0) {
			lines.push(this.fit(`  ${theme.fg("muted", "No items.")}`, width));
			return lines;
		}
		for (const row of visibleRows) {
			lines.push(listPanelRow({
				selected: false,
				label: row.label,
				values: row.values,
				...(row.status ? { status: row.status } : {}),
				widths,
				...(row.detail ? { detail: row.detail } : {}),
				width,
			}));
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
