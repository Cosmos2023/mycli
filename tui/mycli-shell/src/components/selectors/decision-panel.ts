import { getKeybindings, matchesKey, type Component } from "../../tui-core/index.ts";
import { truncateToWidth, wrapTextWithAnsi } from "../../tui-core/utils.ts";
import { theme } from "../../theme/theme.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { renderDecisionItems, type DecisionItem } from "./decision-list.ts";
import { keyHint, rawKeyHint } from "../shared/keybinding-hints.ts";
import { SegmentedHintLine } from "../shared/responsive-row.ts";

export interface DecisionPanelOptions {
	readonly maxHeight?: () => number;
	readonly onRender?: () => void;
}

export interface DecisionPanelContent {
	readonly title: string;
	readonly preview?: Component;
	readonly details?: readonly string[];
	readonly items: readonly DecisionItem[];
	readonly selectedIndex: number;
	readonly hints: readonly string[];
	readonly status?: string;
	readonly busy?: boolean;
	readonly tone?: "accent" | "warning";
	readonly highlightSelection?: boolean;
}

/** Shared bottom-pane geometry; decisions and persistence remain with the caller. */
export class DecisionPanel implements Component {
	private content: DecisionPanelContent = { title: "", items: [], selectedIndex: 0, hints: [] };
	private expanded = false;
	private detailOffset = 0;
	private listOffset = 0;
	private detailHeight = 1;
	private detailLineCount = 0;

	constructor(private readonly options: DecisionPanelOptions = {}) {}

	setContent(content: DecisionPanelContent): void {
		if (content.title !== this.content.title) {
			this.expanded = false;
			this.detailOffset = 0;
			this.listOffset = 0;
		}
		this.content = content;
		this.options.onRender?.();
	}

	invalidate(): void {}

	/** Full-text inspection owns input so hidden choices cannot be accepted. */
	handleInput(data: string): boolean {
		const kb = getKeybindings();
		if (matchesKey(data, "ctrl+a")) {
			this.expanded = !this.expanded;
			this.detailOffset = 0;
		} else if (!this.expanded) {
			return false;
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.expanded = false;
		} else if (kb.matches(data, "tui.select.up") || data === "k") {
			this.detailOffset -= 1;
		} else if (kb.matches(data, "tui.select.down") || data === "j") {
			this.detailOffset += 1;
		} else if (matchesKey(data, "pageUp")) {
			this.detailOffset -= Math.max(1, this.detailHeight - 1);
		} else if (matchesKey(data, "pageDown")) {
			this.detailOffset += Math.max(1, this.detailHeight - 1);
		} else if (matchesKey(data, "home")) {
			this.detailOffset = 0;
		} else if (matchesKey(data, "end")) {
			this.detailOffset = this.detailLineCount;
		}
		this.detailOffset = Math.max(0, Math.min(this.detailOffset, this.detailLineCount - this.detailHeight));
		this.options.onRender?.();
		return true;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const maxHeight = Math.max(1, this.options.maxHeight?.() ?? Number.MAX_SAFE_INTEGER);
		const compact = maxHeight < 7;
		const inset = Math.min(2, Math.floor((safeWidth - 1) / 2));
		const textLines = (text: string): string[] => wrapTextWithAnsi(text.replace(/\r\n?/gu, "\n"), Math.max(1, safeWidth - inset * 2))
			.map((line) => `${" ".repeat(inset)}${line}`);
		const header = [
			...(compact ? [] : [theme.fg(this.content.tone ?? "accent", uiGlyphs().horizontal.repeat(safeWidth))]),
			...textLines(this.content.title).slice(0, maxHeight < 12 ? 1 : 2),
		];
		const details = [
			...(this.content.preview?.render(Math.max(1, safeWidth - inset * 2)) ?? [])
				.map((line) => `${" ".repeat(inset)}${line}`),
			...(this.content.details ?? []).flatMap(textLines),
		];
		const rows = renderDecisionItems(this.content.items, this.content.selectedIndex, safeWidth,
			this.content.busy, this.content.highlightSelection);
		const allRows = rows.flat();
		const status = this.content.status ? textLines(this.content.status) : [];
		const fullText = [...details, ...(details.length && allRows.length ? [""] : []), ...allRows, ...status];
		const footer = new SegmentedHintLine(this.expanded ? [
			keyHint("tui.select.up", "up"),
			keyHint("tui.select.down", "down"),
			rawKeyHint("ctrl+a", "back"),
			keyHint("tui.select.cancel", "back"),
		] : compact ? [keyHint("tui.select.confirm", "confirm"), rawKeyHint("ctrl+a", "view all")]
			: [...this.content.hints, rawKeyHint("ctrl+a", "view all")], inset).render(safeWidth)
			.slice(0, Math.max(1, Math.floor(maxHeight / 3)));
		const statusPreview = this.expanded ? [] : status.slice(0, Math.min(3, Math.max(1, Math.floor(maxHeight / 4))));
		const gap = maxHeight >= 10 ? [""] : [];
		const bodyHeight = Math.max(1, maxHeight - header.length - footer.length - statusPreview.length - gap.length * 2);
		let body: string[];
		if (this.expanded) {
			this.detailHeight = Math.max(1, bodyHeight - 1);
			this.detailLineCount = fullText.length;
			this.detailOffset = Math.max(0, Math.min(this.detailOffset, fullText.length - this.detailHeight));
			body = fullText.slice(this.detailOffset, this.detailOffset + this.detailHeight);
			if (bodyHeight > 1) body.push(...textLines(theme.fg("muted",
				`${fullText.length ? this.detailOffset + 1 : 0}-${this.detailOffset + body.length} / ${fullText.length}`,
			)).slice(0, 1));
		} else {
			body = this.renderBody(details, rows, bodyHeight, textLines);
		}
		return [...header, ...gap, ...body, ...statusPreview, ...gap, ...footer]
			.slice(0, maxHeight)
			// Match Text and visibleWidth's three-cell tabs before writing to the terminal.
			.map((line) => truncateToWidth(line.replaceAll("\t", "   "), safeWidth, "", true));
	}

	private renderBody(
		details: string[],
		rows: string[][],
		height: number,
		textLines: (text: string) => string[],
	): string[] {
		const allRows = rows.flat();
		const separator = details.length && allRows.length ? [""] : [];
		if (details.length + separator.length + allRows.length <= height) {
			this.listOffset = 0;
			return [...details, ...separator, ...allRows];
		}
		const minimumDetails = details.length ? Math.min(2, height - 1) : 0;
		const listReserve = Math.min(allRows.length, Math.max(1, Math.ceil(height * 0.65)), height - minimumDetails);
		const detailBudget = Math.max(0, height - listReserve);
		const visibleDetails = details.slice(0, detailBudget);
		if (details.length > detailBudget && detailBudget > 1) {
			visibleDetails[detailBudget - 1] = textLines(theme.fg("muted", `... ${details.length - detailBudget + 1} more lines`))[0] ?? "";
		}
		const gap = visibleDetails.length && visibleDetails.length + listReserve < height ? separator : [];
		const listBudget = height - visibleDetails.length - gap.length;
		const overflow = allRows.length > listBudget;
		const visibleHeight = Math.max(1, listBudget - (overflow && listBudget > 1 ? 1 : 0));
		const selectedStart = rows.slice(0, this.content.selectedIndex).reduce((sum, row) => sum + row.length, 0);
		const selectedHeight = rows[this.content.selectedIndex]?.length ?? 0;
		if (selectedStart < this.listOffset || selectedHeight >= visibleHeight) {
			this.listOffset = selectedStart;
		} else if (selectedStart + selectedHeight > this.listOffset + visibleHeight) {
			this.listOffset = selectedStart + selectedHeight - visibleHeight;
		}
		this.listOffset = Math.max(0, Math.min(this.listOffset, allRows.length - visibleHeight));
		const visibleRows = allRows.slice(this.listOffset, this.listOffset + visibleHeight);
		if (overflow && listBudget > 1) {
			visibleRows.push(textLines(theme.fg("muted", `${this.content.selectedIndex + 1}/${rows.length} options`))[0] ?? "");
		}
		return [...visibleDetails, ...gap, ...visibleRows];
	}
}
