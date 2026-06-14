import { Container, getKeybindings, Input, Spacer, Text, type TUI, truncateToWidth } from "../tui-core/index.ts";
import type { MycliShellSession } from "../model.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

export type SessionSelectorOptions = {
	tui: TUI;
	sessions: MycliShellSession[];
	onSelect: (session: MycliShellSession) => void;
	onCancel: () => void;
};

function sessionLabel(session: MycliShellSession): string {
	return session.title || session.id;
}

export class SessionSelectorComponent extends Container {
	private readonly searchInput = new Input();
	private readonly listContainer = new Container();
	private readonly sessions: MycliShellSession[];
	private filteredSessions: MycliShellSession[];
	private selectedIndex = 0;
	private readonly onSelectCallback: (session: MycliShellSession) => void;
	private readonly onCancelCallback: () => void;
	private readonly tui: TUI;

	constructor(options: SessionSelectorOptions) {
		super();
		this.tui = options.tui;
		this.sessions = [...options.sessions];
		this.filteredSessions = this.sessions;
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Resume Session"), 0, 0));
		this.addChild(new Text(keyHint("tui.input.tab", "scope") + theme.fg("muted", " · type to search"), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.updateList();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			if (this.filteredSessions.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredSessions.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.filteredSessions.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredSessions.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}
		this.searchInput.handleInput(data);
		this.filter(this.searchInput.getValue());
		this.tui.requestRender();
	}

	private filter(query: string): void {
		const normalized = query.trim().toLowerCase();
		this.filteredSessions = normalized
			? this.sessions.filter((session) => `${session.id} ${session.title ?? ""} ${session.cwd ?? ""}`.toLowerCase().includes(normalized))
			: this.sessions;
		this.selectedIndex = 0;
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		if (this.sessions.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No sessions available"), 0, 0));
			this.listContainer.addChild(new Text(theme.fg("dim", "  mycli runtime did not provide a session list."), 0, 0));
			return;
		}
		if (this.filteredSessions.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching sessions"), 0, 0));
			return;
		}

		const maxVisible = 10;
		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredSessions.length - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, this.filteredSessions.length);
		for (let index = startIndex; index < endIndex; index += 1) {
			const session = this.filteredSessions[index];
			if (!session) continue;
			const selected = index === this.selectedIndex;
			const prefix = selected ? theme.fg("accent", "→ ") : "  ";
			const title = selected ? theme.fg("accent", sessionLabel(session)) : sessionLabel(session);
			const meta = [session.cwd, session.modified].filter(Boolean).join(" · ");
			const line = meta ? `${prefix}${title} ${theme.fg("muted", truncateToWidth(meta, 60, "..."))}` : `${prefix}${title}`;
			this.listContainer.addChild(new Text(line, 0, 0));
		}
	}
}
