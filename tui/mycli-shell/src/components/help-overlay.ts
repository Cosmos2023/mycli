import type { AppKeybinding } from "../keybindings.ts";
import type { MycliShellCommandSpec } from "../model.ts";
import { getKeybindings } from "../tui-core/index.ts";
import type { Component, Focusable } from "../tui-core/tui.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../tui-core/utils.ts";
import { uiGlyphs } from "../theme/terminal-style.ts";
import { theme } from "../theme/theme.ts";
import { formatKeyText } from "./keybinding-hints.ts";

export type HelpOverlayOptions = {
	readonly commands: readonly MycliShellCommandSpec[];
	readonly onClose: () => void;
};

const SHORTCUTS: readonly [AppKeybinding, string][] = [
	["app.commandPalette", "Commands"],
	["app.help", "Help"],
	["app.model.select", "Model"],
	["app.tools.expand", "Tool details"],
	["app.transcript.open", "Transcript"],
	["app.permissions.open", "Permissions"],
	["app.interrupt", "Cancel / interrupt"],
	["app.exit", "Exit when input is empty"],
	["app.message.followUp", "Queue follow-up while running"],
	["app.message.dequeue", "Restore last queued message"],
];

const CATEGORY_LABELS: Readonly<Record<NonNullable<MycliShellCommandSpec["category"]>, string>> = {
	diagnostics: "Diagnostics",
	interface: "Interface",
	model: "Model",
	safety: "Safety",
	session: "Session",
	tools: "Tools",
};

export class HelpOverlayComponent implements Component, Focusable {
	focused = false;

	constructor(private readonly options: HelpOverlayOptions) {}

	invalidate(): void {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const lines = [
			theme.fg("border", uiGlyphs().horizontal.repeat(safeWidth)),
			"",
			theme.bold("Help"),
			theme.fg("muted", "Keyboard shortcuts and Slash commands"),
			"",
			theme.bold("Keyboard"),
			...SHORTCUTS.map(([action, label]) => shortcutLine(action, label)),
			"",
			theme.bold("Commands"),
			...this.commandLines(safeWidth),
			"",
			theme.fg("muted", `Ctrl+P searches commands ${uiGlyphs().separator} Esc closes help`),
			theme.fg("border", uiGlyphs().horizontal.repeat(safeWidth)),
		];
		return lines.flatMap((line) =>
			wrapTextWithAnsi(line, safeWidth).map((wrapped) => truncateToWidth(wrapped, safeWidth, "")));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "app.help")) {
			this.options.onClose();
		}
	}

	private commandLines(width: number): string[] {
		const lines: string[] = [];
		const visible = this.options.commands.filter((command) => command.searchOnly !== true && command.available !== false);
		for (const [category, title] of Object.entries(CATEGORY_LABELS)) {
			const commands = visible.filter((command) => (command.category ?? "tools") === category);
			if (commands.length === 0) continue;
			lines.push(commandGroupLine(title, commands, width));
		}
		return lines;
	}
}

function shortcutLine(action: AppKeybinding, label: string): string {
	const keys = getKeybindings().getKeys(action).map((key) => formatKeyText(key)).join("/");
	const spacing = " ".repeat(Math.max(2, 20 - visibleWidth(keys)));
	return `  ${theme.fg("accent", keys)}${spacing}${label}`;
}

function commandGroupLine(
	title: string,
	commands: readonly MycliShellCommandSpec[],
	width: number,
): string {
	const values = commands.map((command) =>
		`${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`);
	return truncateToWidth(`  ${theme.fg("muted", `${title}:`)} ${values.join(` ${uiGlyphs().separator} `)}`, width, "...");
}
