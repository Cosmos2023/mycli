import { theme } from "../../theme/theme.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../../tui-core/utils.ts";
import { ResponsiveDescriptionRow } from "../shared/responsive-row.ts";
import { keyForAction, keyHint, rawKeyHint } from "../shared/keybinding-hints.ts";

export interface DecisionItem {
	readonly label: string;
	readonly description?: string;
	readonly shortcut?: string;
	readonly current?: boolean;
	readonly disabled?: boolean;
	readonly disabledReason?: string;
}

export function nextDecisionIndex(items: readonly DecisionItem[], current: number, delta: number): number {
	for (let step = 1; step <= items.length; step += 1) {
		const index = ((current + delta * step) % items.length + items.length) % items.length;
		const item = items[index];
		if (item && !item.disabled && !item.disabledReason) return index;
	}
	return current;
}

export function decisionNavigationHints(confirm = "confirm", cancel = "back"): string[] {
	const up = keyForAction("tui.select.up");
	const down = keyForAction("tui.select.down");
	return [
		rawKeyHint(up === "up" && down === "down" ? `${uiGlyphs().up}${uiGlyphs().down}` : `${up}/${down}`, "select"),
		keyHint("tui.select.confirm", confirm),
		keyHint("tui.select.cancel", cancel),
	];
}

export function renderDecisionItems(
	items: readonly DecisionItem[],
	selectedIndex: number,
	width: number,
	busy = false,
	highlightSelection = false,
): string[][] {
	const labels = items.map((item) => [
		item.shortcut ? `${item.shortcut}. ` : "",
		item.label,
		item.current ? " (current)" : "",
		item.disabled || item.disabledReason ? " (unavailable)" : "",
	].join(""));
	const labelWidth = Math.max(0, ...labels.map(visibleWidth));
	const descriptionWidth = width - labelWidth - 6;
	const columns = width >= 72 && descriptionWidth >= 24;

	return items.map((item, index) => {
		const selected = index === selectedIndex;
		const inactive = busy || item.disabled || Boolean(item.disabledReason);
		const prefix = selected ? theme.fg("accent", `${uiGlyphs().selector} `) : "  ";
		const labelText = selected && highlightSelection ? theme.bold(labels[index] ?? "") : labels[index] ?? "";
		const label = theme.fg(inactive ? "muted" : selected && !highlightSelection ? "accent" : "text", labelText);
		const description = item.disabledReason ?? item.description ?? "";
		const styledDescription = theme.fg(item.disabledReason ? "warning" : "muted", description);
		const padding = " ".repeat(labelWidth - visibleWidth(label) + 2);
		const lines = !columns || !description
			? new ResponsiveDescriptionRow(prefix, label, styledDescription, 0).render(width)
			: wrapTextWithAnsi(styledDescription, descriptionWidth).map((line, lineIndex) =>
			lineIndex === 0
				? `${prefix}${label}${padding}${line}`
				: `${" ".repeat(labelWidth + 4)}${line}`,
		);
		return selected && highlightSelection
			? lines.map((line) => applyBackgroundToLine(line, width, (text) => theme.bg("selectedBg", text)))
			: lines;
	});
}
