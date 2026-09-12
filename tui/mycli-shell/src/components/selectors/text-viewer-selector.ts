import { safeErrorMessage } from "../../safe-ui-text.ts";
import { wrapTextWithAnsi, applyBackgroundToLine } from "../../tui-core/utils.ts";
import { getKeybindings, matchesKey, truncateToWidth, type Component } from "../../tui-core/index.ts";
import { theme } from "../../theme/theme.ts";
import { rawKeyHint } from "../shared/keybinding-hints.ts";
import type { DecisionPanelOptions } from "./decision-panel.ts";

export class TextViewerSelectorComponent implements Component {
	private controller?: AbortController;
	private disposed = false;
	private text = "Loading…";
	private offset = 0;
	private pageSize = 1;
	private lines = 1;
	private cache?: { width: number; text: string; lines: string[] };
	constructor(private readonly options: DecisionPanelOptions & {
		readonly title: string; readonly diff?: boolean;
		readonly load: (signal: AbortSignal) => Promise<string>;
		readonly onCancel: () => void;
	}) { void this.load(); }
	invalidate(): void { this.cache = undefined; }
	dispose(): void { this.disposed = true; this.controller?.abort(); }
	handleInput(data: string): void {
		if (this.disposed) return;
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.cancel")) { this.dispose(); this.options.onCancel(); return; }
		if (matchesKey(data, "ctrl+r")) { void this.load(); return; }
		if (keys.matches(data, "tui.select.up")) this.offset--;
		if (keys.matches(data, "tui.select.down")) this.offset++;
		if (keys.matches(data, "tui.select.pageUp")) this.offset -= this.pageSize;
		if (keys.matches(data, "tui.select.pageDown")) this.offset += this.pageSize;
		if (matchesKey(data, "home")) this.offset = 0;
		if (matchesKey(data, "end")) this.offset = this.lines;
		this.offset = Math.max(0, Math.min(this.offset, this.lines - this.pageSize)); this.options.onRender?.();
	}
	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const height = Math.max(1, this.options.maxHeight?.() ?? 20);
		this.pageSize = Math.max(1, height - 2);
		if (!this.cache || this.cache.width !== safeWidth || this.cache.text !== this.text) {
			this.cache = { width: safeWidth, text: this.text, lines: this.text.replace(/[^\P{Cc}\n\t]|\p{Cf}/gu, " ").replaceAll("\t", "   ").split("\n").flatMap((line) => {
				const color = this.options.diff && !line.startsWith("+++") && line.startsWith("+") ? "toolDiffAddedBg"
					: this.options.diff && !line.startsWith("---") && line.startsWith("-") ? "toolDiffRemovedBg" : undefined;
				return wrapTextWithAnsi(line, safeWidth).map((row) => {
					const fitted = truncateToWidth(row, safeWidth);
					return color ? applyBackgroundToLine(fitted, safeWidth, (value) => theme.bg(color, value)) : fitted;
				});
			}) };
		}
		this.lines = this.cache.lines.length;
		this.offset = Math.max(0, Math.min(this.offset, this.lines - this.pageSize));
		return [truncateToWidth(theme.bold(this.options.title), safeWidth), ...this.cache.lines.slice(this.offset, this.offset + this.pageSize),
			truncateToWidth(`${this.offset + 1}/${this.lines}  ${rawKeyHint("↑↓", "scroll")}  ${rawKeyHint("ctrl+r", "refresh")}  ${rawKeyHint("esc", "close")}`, safeWidth)].slice(0, height);
	}
	private async load(): Promise<void> {
		this.controller?.abort(); const controller = new AbortController(); this.controller = controller;
		this.text = "Loading…"; this.options.onRender?.();
		try { const text = await this.options.load(controller.signal); if (!this.disposed && !controller.signal.aborted) this.text = text; }
		catch (error) { if (!this.disposed && !controller.signal.aborted) this.text = `${safeErrorMessage(error, "Unable to load this view.")}\nCtrl+R to retry.`; }
		finally { if (!this.disposed && !controller.signal.aborted) { this.offset = 0; this.options.onRender?.(); } }
	}
}
