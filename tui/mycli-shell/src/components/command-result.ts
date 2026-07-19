import type { Component } from "../tui-core/tui.ts";
import { Container } from "../tui-core/tui.ts";
import { truncateToWidth, visibleWidth } from "../tui-core/utils.ts";
import type {
	MycliShellCommandDiagnostic,
	MycliShellCommandField,
	MycliShellCommandResult,
	MycliShellCommandRow,
	MycliShellDiagnosticMetric,
} from "../model.ts";
import type { ThemeColor } from "../theme/theme.ts";
import { theme } from "../theme/theme.ts";
import { CommandDiagnosticComponent } from "./command-diagnostic.ts";

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
		switch (this.result.display.kind) {
			case "status":
				return this.renderStatus(safeWidth);
			case "diagnostic":
				return new CommandDiagnosticComponent(this.diagnostic()).render(safeWidth);
			case "list":
				return this.renderList(safeWidth);
			case "notice":
				return this.renderNotice(safeWidth);
			case "error":
				return this.renderError(safeWidth);
			case "preformatted":
				return this.renderPreformatted(safeWidth);
	}
	}

	private renderStatus(width: number): string[] {
		if (width < 8) {
			return [this.fit(this.result.display.summary ?? this.result.display.title, width)];
		}
		const boxWidth = Math.min(STATUS_MAX_WIDTH, width);
		const contentWidth = boxWidth - 6;
		const borderWidth = boxWidth - 2;
		const lines = [theme.fg("border", `╭${"─".repeat(borderWidth)}╮`)];
		const title = this.result.display.summary
			? `${this.result.display.title}  ${this.result.display.summary}`
			: this.result.display.title;
		lines.push(this.statusLine(theme.bold(title), contentWidth));
		const fields = [
			...this.result.display.fields,
			...this.result.display.sections.flatMap((section) => section.fields),
		];
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
		lines.push(theme.fg("border", `╰${"─".repeat(borderWidth)}╯`));
		return lines;
	}

	private statusLine(text: string, contentWidth: number): string {
		const content = truncateToWidth(text, contentWidth, theme.fg("dim", "..."), true);
		return `${theme.fg("border", "│")}  ${content}  ${theme.fg("border", "│")}`;
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
		const marker = display.severity === "success" ? "✓" : display.severity === "info" ? "•" : "!";
		const color: ThemeColor = display.severity === "success"
			? "success"
			: display.severity === "error"
				? "error"
				: display.severity === "warning"
					? "warning"
					: "accent";
		return [this.fit(`${theme.fg(color, marker)} ${display.summary ?? display.title}`, width)];
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

	private diagnostic(): MycliShellCommandDiagnostic {
		const display = this.result.display;
		return {
			id: this.result.id,
			command: display.command,
			title: display.title,
			kind: display.command === "/usage" ? "usage" : display.command === "/context" ? "context" : "generic",
			metrics: display.fields.map((field) => ({
				label: field.label,
				value: field.value,
				accent: this.diagnosticAccent(field),
			})),
			sections: display.sections.map((section) => ({
				title: section.title,
				rows: [
					...section.fields.map((field) => ({
						label: field.label,
						value: field.value,
						accent: this.diagnosticAccent(field),
					})),
					...section.rows.map((row) => ({
						label: row.label,
						value: [...row.values, ...(row.detail ? [row.detail] : [])].join("  "),
						accent: "muted" as const,
					})),
				],
			})),
		};
	}

	private fieldColor(field: MycliShellCommandField): ThemeColor {
		return field.tone === "success" || field.tone === "warning" || field.tone === "error"
			? field.tone
			: field.tone === "accent"
				? "accent"
				: "text";
	}

	private diagnosticAccent(
		field: MycliShellCommandField,
	): MycliShellDiagnosticMetric["accent"] {
		return field.tone === "success" ||
			field.tone === "warning" ||
			field.tone === "error" ||
			field.tone === "accent" ||
			field.tone === "muted"
			? field.tone
			: "muted";
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
}

function sanitize(value: string): string {
	return value.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim();
}

function padVisible(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}
