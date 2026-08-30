import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	truncateToWidth,
	type TUI,
} from "../tui-core/index.ts";
import type { MycliShellCommandSpec, MycliShellSettingsCatalog } from "../model.ts";
import { theme } from "../theme/theme.ts";

export type CommandPaletteOptions = {
	readonly tui: TUI;
	readonly commands: readonly MycliShellCommandSpec[];
	readonly turnRunning: boolean;
	readonly settingsCatalog?: MycliShellSettingsCatalog;
	readonly onSelect: (command: MycliShellCommandSpec) => void;
	readonly onCancel: () => void;
};

export class CommandPaletteComponent extends Container implements Focusable {
	private readonly searchInput = new Input();
	private readonly tui: TUI;
	private readonly commands: MycliShellCommandSpec[];
	private readonly defaultCommands: MycliShellCommandSpec[];
	private filteredCommands: MycliShellCommandSpec[];
	private selectedIndex = 0;
	private readonly turnRunning: boolean;
	private readonly settingsCatalog?: MycliShellSettingsCatalog;
	private readonly onSelectCallback: (command: MycliShellCommandSpec) => void;
	private readonly onCancelCallback: () => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(options: CommandPaletteOptions) {
		super();
		this.tui = options.tui;
		this.commands = [...options.commands];
		this.defaultCommands = this.commands.filter((command) => command.searchOnly !== true && command.available !== false);
		this.filteredCommands = this.defaultCommands;
		this.turnRunning = options.turnRunning;
		this.settingsCatalog = options.settingsCatalog;
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;
		this.searchInput.onSubmit = () => this.confirm();
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const border = theme.fg("border", "─".repeat(safeWidth));
		const lines = [
			border,
			"",
			theme.bold("Commands"),
			theme.fg("muted", "Type to search · Enter run · Esc close"),
			"",
			...this.searchInput.render(safeWidth),
			"",
			...this.commandRows(safeWidth),
			"",
			theme.fg("muted", this.resultCount()),
			border,
		];
		return lines.map((line) => truncateToWidth(line, safeWidth, theme.fg("dim", "...")));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = previousIndex(this.selectedIndex, this.filteredCommands.length);
		} else if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = nextIndex(this.selectedIndex, this.filteredCommands.length);
		} else if (kb.matches(data, "tui.select.confirm")) {
			this.confirm();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.onCancelCallback();
		} else {
			this.searchInput.handleInput(data);
			this.filter(this.searchInput.getValue());
		}
		this.tui.requestRender();
	}

	private filter(query: string): void {
		this.filteredCommands = query.trim()
			? fuzzyFilter(this.commands, query, (command) => this.searchText(command))
			: this.defaultCommands;
		this.selectedIndex = 0;
	}

	private confirm(): void {
		const command = this.filteredCommands[this.selectedIndex];
		if (!command || this.disabledReason(command)) return;
		this.onSelectCallback(command);
	}

	private commandRows(width: number): string[] {
		if (this.filteredCommands.length === 0) {
			return [theme.fg("muted", "  No matching commands")];
		}
		const maxVisible = 10;
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - 4, this.filteredCommands.length - maxVisible),
		);
		const end = Math.min(start + maxVisible, this.filteredCommands.length);
		const rows = this.filteredCommands.slice(start, end).map((command, offset) => {
			const index = start + offset;
			const selected = index === this.selectedIndex;
			const disabledReason = this.disabledReason(command);
			const disabled = disabledReason !== undefined;
			const commandText = `${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`;
			const status = disabled ? `  ${disabledReason}` : `  ${command.description}`;
			const prefix = selected ? "› " : "  ";
			if (disabled) return theme.fg("dim", `${prefix}${commandText}${status}`);
			return selected
				? theme.fg("accent", `${prefix}${commandText}${status}`)
				: `${prefix}${commandText}${theme.fg("muted", status)}`;
		});
		return rows.map((row) => truncateToWidth(row, width, theme.fg("dim", "...")));
	}

	private resultCount(): string {
		const position = this.filteredCommands.length === 0 ? 0 : this.selectedIndex + 1;
		if (!this.searchInput.getValue().trim()) {
			return `${position}/${this.defaultCommands.length}`;
		}
		return `${position}/${this.filteredCommands.length} · ${this.filteredCommands.length}/${this.commands.length} matches`;
	}

	private disabledReason(command: MycliShellCommandSpec): string | undefined {
		if (command.available === false) return command.unavailableReason ?? "unavailable in this runtime";
		if (this.turnRunning && !command.availableDuringTurn) return "unavailable while running";
		return undefined;
	}

	private searchText(command: MycliShellCommandSpec): string {
		const settings = this.settingsCatalog?.items.filter((item) =>
			item.command === command.name || (command.id === "settings" && item.kind === "choice")) ?? [];
		return [
			command.name,
			...(command.aliases ?? []),
			command.argumentHint,
			command.description,
			command.category,
			...settings.flatMap((item) => [
				item.label, item.description, item.value, item.source, item.scope, ...item.searchTerms,
			]),
		].filter(Boolean).join(" ");
	}
}

function previousIndex(index: number, length: number): number {
	return length === 0 ? 0 : (index - 1 + length) % length;
}

function nextIndex(index: number, length: number): number {
	return length === 0 ? 0 : (index + 1) % length;
}
