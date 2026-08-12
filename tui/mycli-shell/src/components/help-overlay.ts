import type { AppKeybinding } from "../keybindings.ts";
import type { MycliShellCommandSpec } from "../model.ts";
import { getKeybindings } from "../tui-core/index.ts";
import type { Component, Focusable } from "../tui-core/tui.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../tui-core/utils.ts";
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

const COMMAND_GROUPS: readonly [string, ReadonlySet<string>][] = [
	["Session", new Set(["new", "resume", "fork", "status", "usage", "compact"])],
	["Model", new Set(["model", "plan", "permissions"])],
	["Tools", new Set(["skills", "tools", "agents", "ps", "changes"])],
];

export class HelpOverlayComponent implements Component, Focusable {
	focused = false;

	constructor(private readonly options: HelpOverlayOptions) {}

	invalidate(): void {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const lines = [
			theme.fg("border", "─".repeat(safeWidth)),
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
			theme.fg("muted", "Ctrl+P searches commands · Esc closes help"),
			theme.fg("border", "─".repeat(safeWidth)),
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
		const assigned = new Set<string>();
		const lines: string[] = [];
		for (const [title, ids] of COMMAND_GROUPS) {
			const commands = this.options.commands.filter((command) => ids.has(command.id));
			if (commands.length === 0) continue;
			commands.forEach((command) => assigned.add(command.id));
			lines.push(commandGroupLine(title, commands, width));
		}
		const other = this.options.commands.filter((command) => !assigned.has(command.id));
		if (other.length > 0) lines.push(commandGroupLine("Other", other, width));
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
	return truncateToWidth(`  ${theme.fg("muted", `${title}:`)} ${values.join(" · ")}`, width, "...");
}
