import { stripVTControlCharacters } from "node:util";
import type { MycliShellCommandResult, MycliShellCommandRow } from "../../model.ts";
import { theme } from "../../theme/theme.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { Container, getKeybindings, Input, matchesKey, type Focusable } from "../../tui-core/index.ts";
import { truncateToWidth, wrapTextWithAnsi } from "../../tui-core/utils.ts";
import { keyForAction, keyHint, rawKeyHint } from "../shared/keybinding-hints.ts";
import { CommandResultComponent } from "../transcript/command-result.ts";

interface CommandResultOverlayOptions {
	readonly maxHeight?: () => number;
	readonly onRender?: () => void;
}

export class CommandResultOverlayComponent extends Container implements Focusable {
	private readonly searchInput = new Input();
	private readonly content: CommandResultComponent;
	private rows: MycliShellCommandRow[];
	private selectedIndex = 0;
	private inspecting = false;
	private scrollOffset = 0;
	private bodyHeight = 1;
	private hasFocus = false;

	constructor(
		private readonly result: MycliShellCommandResult,
		private readonly onClose: () => void,
		private readonly options: CommandResultOverlayOptions = {},
	) {
		super();
		this.content = new CommandResultComponent({ ...result, folded: false });
		this.rows = [...result.display.rows];
	}

	get focused(): boolean { return this.hasFocus; }

	set focused(value: boolean) {
		this.hasFocus = value;
		this.searchInput.focused = value && this.listVisible();
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const height = Math.max(1, Math.floor(this.options.maxHeight?.() ?? 18));
		const list = this.listVisible();
		const title = this.inspecting ? this.rows[this.selectedIndex]?.label ?? this.result.display.title
			: this.result.display.title;
		const header = !list && !this.inspecting ? [] : [
			...(height >= 7 ? [theme.fg("border", uiGlyphs().horizontal.repeat(safeWidth))] : []),
			`${theme.fg("accent", theme.bold(singleLine(title)))}${list ? theme.fg("muted", `  ${this.count()}`) : ""}`,
			...(list && height >= 5 ? this.searchInput.render(safeWidth) : []),
		];
		this.bodyHeight = Math.min(list ? 12 : Number.MAX_SAFE_INTEGER, Math.max(1, height - header.length - 1));
		const body = list ? this.listRows(safeWidth) : this.contentLines(safeWidth);
		const navigation = `${keyForAction("tui.select.up")}/${keyForAction("tui.select.down")}`;
		const footer = list ? [
			keyHint("tui.select.cancel", "close"), keyHint("tui.select.confirm", "details"),
			rawKeyHint(navigation, "select"),
		] : [
			keyHint("tui.select.cancel", this.inspecting ? "back" : "close"),
			rawKeyHint(navigation, "scroll"),
		];
		return [...header, ...body, footer.join("  ")].slice(0, height)
			.map((line) => truncateToWidth(line, safeWidth, "...", true));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.inspecting) {
				this.inspecting = false;
				this.scrollOffset = 0;
			} else this.onClose();
		} else if (this.listVisible() && kb.matches(data, "tui.select.confirm")) {
			if (this.rows[this.selectedIndex]) {
				this.inspecting = true;
				this.scrollOffset = 0;
			}
		} else if (kb.matches(data, "tui.select.up") || (!this.listVisible() && data === "k")) {
			this.move(-1);
		} else if (kb.matches(data, "tui.select.down") || (!this.listVisible() && data === "j")) {
			this.move(1);
		} else if (kb.matches(data, "tui.select.pageUp")) {
			this.move(-this.bodyHeight);
		} else if (kb.matches(data, "tui.select.pageDown")) {
			this.move(this.bodyHeight);
		} else if (matchesKey(data, "home")) {
			this.move(-Number.MAX_SAFE_INTEGER);
		} else if (matchesKey(data, "end")) {
			this.move(Number.MAX_SAFE_INTEGER);
		} else if (this.listVisible()) {
			this.searchInput.handleInput(data);
			const tokens = this.searchInput.getValue().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
			this.rows = this.result.display.rows.filter((row) => {
				const text = [row.label, ...row.values, row.status, row.detail].filter(Boolean).join(" ").toLocaleLowerCase();
				return tokens.every((token) => text.includes(token));
			});
			this.selectedIndex = 0;
		}
		this.focused = this.hasFocus;
		this.options.onRender?.();
	}

	private listVisible(): boolean {
		return this.result.display.kind === "list" && !this.inspecting;
	}

	private move(delta: number): void {
		if (this.listVisible()) {
			this.selectedIndex = Math.max(0, Math.min(this.rows.length - 1, this.selectedIndex + delta));
		} else this.scrollOffset = Math.max(0, this.scrollOffset + delta);
	}

	private count(): string {
		const available = this.result.display.rows.length;
		const total = this.result.display.totalRows ?? available + this.result.display.omittedRows;
		const position = this.rows.length ? this.selectedIndex + 1 : 0;
		return `${position}/${this.rows.length}${total > available ? `  ${available} of ${total} loaded` : ""}`;
	}

	private listRows(width: number): string[] {
		const height = this.bodyHeight;
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(height / 2), this.rows.length - height));
		const lines = this.rows.slice(start, start + height).map((row, index) => {
			const selected = start + index === this.selectedIndex;
			const prefix = selected ? `${uiGlyphs().selector} ` : "  ";
			const meta = [...row.values, ...(row.status ? [row.status] : [])].map(singleLine).join("  ");
			const detail = row.detail ? `  ${theme.fg("dim", singleLine(row.detail))}` : "";
			return truncateToWidth(`${theme.fg(selected ? "accent" : "text", prefix + singleLine(row.label))}  ${theme.fg("muted", meta)}${detail}`, width, "...");
		});
		if (!lines.length) lines.push(theme.fg("muted", this.searchInput.getValue() ? "  No matching items." : "  No items."));
		while (lines.length < height) lines.push("");
		return lines;
	}

	private contentLines(width: number): string[] {
		const row = this.inspecting ? this.rows[this.selectedIndex] : undefined;
		const lines = row ? [
			singleLine(row.label),
			...row.values.map(singleLine),
			...(row.status ? [`Status: ${singleLine(row.status)}`] : []),
			...(row.detail ? ["", stripVTControlCharacters(row.detail).replace(/\r\n?/gu, "\n").replaceAll("\t", "   ")] : []),
		].flatMap((text) => wrapTextWithAnsi(text, width)) : this.content.render(width);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, lines.length - this.bodyHeight));
		return lines.slice(this.scrollOffset, this.scrollOffset + this.bodyHeight);
	}
}

function singleLine(value: string): string {
	return stripVTControlCharacters(value).replace(/\s+/gu, " ").trim();
}
