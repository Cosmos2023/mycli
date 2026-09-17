import { Container, getKeybindings, matchesKey, Input, Spacer, Text, TruncatedText, type TUI, truncateToWidth, visibleWidth } from "../../tui-core/index.ts";
import type { MycliShellSession } from "../../model.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme } from "../../theme/theme.ts";
import { DynamicBorder } from "../shared/dynamic-border.ts";
import { keyHint, rawKeyHint } from "../shared/keybinding-hints.ts";
import { filterSessions, sessionDisplayTitle, type SessionNameFilter, type SessionScope, type SessionSortMode } from "./session-selector-search.ts";

export type SessionSelectorOptions = {
	tui: TUI;
	sessions: MycliShellSession[];
	currentWorkspace?: string;
	onPreview?: (session: MycliShellSession) => void;
	onSelect: (session: MycliShellSession) => void;
	onCancel: () => void;
};

export class SessionSelectorComponent extends Container {
	private readonly searchInput = new Input();
	private readonly listContainer = new Container();
	private sessions: MycliShellSession[];
	private filteredSessions: MycliShellSession[];
	private selectedIndex = 0;
	private scope: SessionScope = "current";
	private sortMode: SessionSortMode = "recent";
	private nameFilter: SessionNameFilter = "all";
	private showPath = true;
	private error: string | null = null;
	private submitting = false;
	private loading = false;
	private readonly currentWorkspace?: string;
	private readonly onSelectCallback: (session: MycliShellSession) => void;
	private readonly onCancelCallback: () => void;
	private readonly tui: TUI;

	constructor(private readonly options: SessionSelectorOptions) {
		super();
		this.tui = options.tui;
		this.sessions = [...options.sessions];
		this.currentWorkspace = options.currentWorkspace;
		if (!this.currentWorkspace) {
			this.scope = "all";
		}
		this.filteredSessions = this.applyFilters("");
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild({
			render: (width) => this.headerLines(width),
			invalidate: () => {},
		});
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.updateList();
	}

	setError(message: string): void {
		this.submitting = false;
		this.loading = false;
		this.error = message.trim() || "Unable to resume this session.";
		this.updateList();
	}

	setLoading(): void {
		this.loading = true;
		this.error = null;
		this.updateList();
	}

	setSessions(sessions: MycliShellSession[]): void {
		const selected = this.filteredSessions[this.selectedIndex]?.id;
		this.sessions = [...sessions];
		this.loading = false;
		this.error = null;
		this.filteredSessions = this.applyFilters(this.searchInput.getValue());
		this.selectedIndex = Math.max(0, this.filteredSessions.findIndex((session) => session.id === selected));
		this.updateList();
	}

	handleInput(data: string): void {
		if (this.submitting) return;
		const kb = getKeybindings();
		if (matchesKey(data, "ctrl+p")) { const selected = this.filteredSessions[this.selectedIndex]; if (selected && !this.loading) this.options.onPreview?.(selected); return; }
		if (kb.matches(data, "tui.input.tab")) {
			this.scope = this.scope === "current" ? "all" : "current";
			this.filter(this.searchInput.getValue());
			this.tui.requestRender();
			return;
		}
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
			if (this.loading) return;
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected) {
				this.submitting = true;
				this.onSelectCallback(selected);
			}
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
		this.error = null;
		this.filteredSessions = this.applyFilters(query);
		this.selectedIndex = 0;
		this.updateList();
	}

	private applyFilters(query: string): MycliShellSession[] {
		return filterSessions(this.sessions, {
			query,
			scope: this.scope,
			sortMode: this.sortMode,
			nameFilter: this.nameFilter,
			currentWorkspace: this.currentWorkspace,
		});
	}

	private headerLines(width: number): string[] {
		const title = theme.bold("Resume Session");
		const scope = `${theme.fg("muted", "Scope: ")}${theme.fg("accent", this.scope)}`;
		const sort = `${theme.fg("muted", "Sort: ")}${theme.fg("accent", this.sortMode)}`;
		const name = `${theme.fg("muted", "Name: ")}${theme.fg("accent", this.nameFilter)}`;
		const right = `${scope}  ${name}  ${sort}`;
		const titleWidth = visibleWidth(title);
		const rightWidth = visibleWidth(right);
		const gap = Math.max(1, width - titleWidth - rightWidth);
		const first = truncateToWidth(`${title}${" ".repeat(gap)}${right}`, width, "");
		const pathState = this.showPath ? "on" : "off";
		const second = truncateToWidth(
			[
				keyHint("tui.input.tab", "scope"),
				...(this.options.onPreview ? [rawKeyHint("ctrl+p", "preview")] : []),
				theme.fg("muted", `type to search ${uiGlyphs().separator} re:<pattern> regex ${uiGlyphs().separator} "phrase" exact`),
				theme.fg("muted", `path ${pathState}`),
			].join(theme.fg("muted", ` ${uiGlyphs().separator} `)),
			width,
			"...",
		);
		return [first, second];
	}

	private updateList(): void {
		this.listContainer.clear();
		if (this.loading) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  Loading sessions..."), 0, 0));
			this.tui.requestRender();
			return;
		}
		if (this.error) {
			this.listContainer.addChild(new Text(theme.fg("error", `  ${this.error}`), 0, 0));
			this.listContainer.addChild(new Spacer(1));
		}
		if (this.sessions.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No sessions available"), 0, 0));
			this.listContainer.addChild(new Text(theme.fg("dim", "  mycli runtime did not provide a session list."), 0, 0));
			return;
		}
		if (this.filteredSessions.length === 0) {
			const scopeHint = this.scope === "current" ? " Press Tab to search all sessions." : "";
			this.listContainer.addChild(new Text(theme.fg("muted", `  No matching sessions.${scopeHint}`), 0, 0));
			return;
		}

		const maxVisible = 7;
		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredSessions.length - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, this.filteredSessions.length);
		for (let index = startIndex; index < endIndex; index += 1) {
			const session = this.filteredSessions[index];
			if (!session) continue;
			const selected = index === this.selectedIndex;
			const prefix = selected ? theme.fg("accent", `${uiGlyphs().arrow} `) : "  ";
			const titleText = sessionDisplayTitle(session);
			const title = selected ? theme.fg("accent", titleText) : titleText;
			const current = session.current ? "current" : undefined;
			const count = session.messageCount === undefined ? undefined : `${session.messageCount} msg`;
			const activity = session.modified ?? session.lastActive;
			const primaryMeta = [current, sessionStatusLabel(session), activity, count].filter(Boolean).join(` ${uiGlyphs().separator} `);
			const primary = primaryMeta ? `${prefix}${title} ${theme.fg("muted", primaryMeta)}` : `${prefix}${title}`;
			this.listContainer.addChild(new TruncatedText(primary, 0, 0));
			const id = session.title || session.firstMessage ? session.id : undefined;
			const path = this.showPath ? (session.cwd ?? session.workspace) : undefined;
			const model = session.model
				? `${session.model}${session.reasoningEffort ? `/${session.reasoningEffort}` : ""}`
				: undefined;
			const relation = session.parentSessionId ? `fork of ${session.parentSessionId}` : undefined;
			const lock = session.lockState && session.lockState !== "unlocked"
				? `${session.lockState} lock`
				: undefined;
			const detail = [model, session.collaborationMode, session.permissionProfile, lock, relation, path, id]
				.filter(Boolean)
				.join(` ${uiGlyphs().separator} `);
			if (detail) this.listContainer.addChild(new TruncatedText(theme.fg("muted", `    ${detail}`), 0, 0));
		}
		if (this.filteredSessions.length > maxVisible) {
			this.listContainer.addChild(new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredSessions.length})`), 0, 0));
		}
	}
}

function sessionStatusLabel(session: MycliShellSession): string | undefined {
	if (session.lifecycleStatus === "waiting_approval") return "approval pending";
	if (session.lifecycleStatus === "waiting_clarification") return "question pending";
	if (session.lifecycleStatus === "interrupted") return "interrupted";
	if (session.lifecycleStatus === "archived") return "archived";
	if (session.lifecycleStatus === "deleted") return "deleted";
	return undefined;
}
