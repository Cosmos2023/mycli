import {
	Container,
	type Focusable,
	getKeybindings,
	Input,
	truncateToWidth,
	type TUI,
	visibleWidth,
} from "../../tui-core/index.ts";
import { wrapTextWithAnsi } from "../../tui-core/utils.ts";
import type {
	MycliShellSettingsCatalog,
	MycliShellSettingsCategoryId,
	MycliShellSettingsItem,
	MycliShellVisualSettings,
} from "../../model.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme } from "../../theme/theme.ts";
import { keyHint } from "../shared/keybinding-hints.ts";

type SettingsStage = "list" | "scope" | "value";
export type SettingsChangeScope = "session" | "user";

export type SettingsSelectorOptions = {
	readonly tui: TUI;
	readonly settings?: MycliShellVisualSettings;
	readonly catalog?: MycliShellSettingsCatalog;
	readonly onAction: (item: MycliShellSettingsItem, selector: SettingsSelectorComponent) => void;
	readonly onChange: (
		item: MycliShellSettingsItem,
		value: string,
		scope: SettingsChangeScope,
		selector: SettingsSelectorComponent,
	) => void;
	readonly onCancel: () => void;
};

const CATEGORY_ORDER: readonly (MycliShellSettingsCategoryId | "all")[] = [
	"all", "model", "providers", "permissions", "appearance", "sessions", "integrations", "diagnostics",
];

const SCOPE_OPTIONS: readonly {
	readonly id: SettingsChangeScope;
	readonly label: string;
	readonly description: string;
}[] = [
	{ id: "session", label: "Use for this session", description: "Apply now without writing user configuration" },
	{ id: "user", label: "Make user default", description: "Persist atomically for future sessions" },
];

export class SettingsSelectorComponent extends Container implements Focusable {
	private readonly searchInput = new Input();
	private catalog: MycliShellSettingsCatalog;
	private filteredItems: MycliShellSettingsItem[] = [];
	private selectedIndex = 0;
	private categoryIndex = 0;
	private stage: SettingsStage = "list";
	private selectedValueIndex = 0;
	private selectedScopeIndex = 0;
	private pendingItem?: MycliShellSettingsItem;
	private pendingValue?: string;
	private error?: string;
	private submitting = false;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value && this.stage === "list";
	}

	constructor(private readonly options: SettingsSelectorOptions) {
		super();
		this.catalog = options.catalog ?? fallbackSettingsCatalog(options.settings);
		this.searchInput.onSubmit = () => this.confirmListItem();
		this.applyFilter();
	}

	setError(message: string): void {
		this.submitting = false;
		this.error = message.trim().slice(0, 512) || "Unable to update this setting.";
		this.options.tui.requestRender();
	}

	commit(value: string, scope: SettingsChangeScope, catalog?: MycliShellSettingsCatalog): void {
		if (catalog) {
			this.catalog = catalog;
		} else if (this.pendingItem) {
			this.catalog = {
				...this.catalog,
				items: this.catalog.items.map((item) => item.id === this.pendingItem?.id
					? { ...item, value, source: scope === "user" ? "user" : "session", scope }
					: item),
			};
		}
		this.stage = "list";
		this.pendingItem = undefined;
		this.pendingValue = undefined;
		this.error = undefined;
		this.submitting = false;
		this.searchInput.focused = this.focused;
		this.applyFilter();
		this.options.tui.requestRender();
	}

	replaceCatalog(catalog: MycliShellSettingsCatalog): void {
		this.catalog = catalog;
		this.error = undefined;
		this.submitting = false;
		this.applyFilter();
		this.options.tui.requestRender();
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const border = theme.fg("border", uiGlyphs().horizontal.repeat(safeWidth));
		const lines = [border, ""];
		if (this.stage === "value") {
			lines.push(...this.renderValueStage(safeWidth));
		} else if (this.stage === "scope") {
			lines.push(...this.renderScopeStage(safeWidth));
		} else {
			lines.push(...this.renderListStage(safeWidth));
		}
		if (this.error) {
			lines.push("", theme.fg("error", `  ${this.error}`));
		}
		lines.push("", border);
		return lines.flatMap((line) => wrapTextWithAnsi(line, safeWidth)
			.map((wrapped) => truncateToWidth(wrapped, safeWidth, theme.fg("dim", "..."))));
	}

	handleInput(data: string): void {
		if (this.submitting) return;
		this.error = undefined;
		const kb = getKeybindings();
		if (this.stage === "scope") {
			this.handleScopeInput(data, kb);
		} else if (this.stage === "value") {
			this.handleValueInput(data, kb);
		} else {
			this.handleListInput(data, kb);
		}
		this.options.tui.requestRender();
	}

	private handleListInput(data: string, kb: ReturnType<typeof getKeybindings>): void {
		if (kb.matches(data, "tui.input.tab")) {
			this.categoryIndex = (this.categoryIndex + 1) % CATEGORY_ORDER.length;
			this.applyFilter();
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = previousIndex(this.selectedIndex, this.filteredItems.length);
		} else if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = nextIndex(this.selectedIndex, this.filteredItems.length);
		} else if (kb.matches(data, "tui.select.confirm")) {
			this.confirmListItem();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.options.onCancel();
		} else {
			this.searchInput.handleInput(data);
			this.applyFilter();
		}
	}

	private handleValueInput(data: string, kb: ReturnType<typeof getKeybindings>): void {
		const values = this.pendingItem?.allowedValues ?? [];
		if (kb.matches(data, "tui.select.up")) {
			this.selectedValueIndex = previousIndex(this.selectedValueIndex, values.length);
		} else if (kb.matches(data, "tui.select.down")) {
			this.selectedValueIndex = nextIndex(this.selectedValueIndex, values.length);
		} else if (kb.matches(data, "tui.select.confirm")) {
			const value = values[this.selectedValueIndex];
			if (!value) return;
			this.pendingValue = value;
			this.selectedScopeIndex = 0;
			this.stage = "scope";
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.backToList();
		}
	}

	private handleScopeInput(data: string, kb: ReturnType<typeof getKeybindings>): void {
		if (kb.matches(data, "tui.select.up")) {
			this.selectedScopeIndex = previousIndex(this.selectedScopeIndex, SCOPE_OPTIONS.length);
		} else if (kb.matches(data, "tui.select.down")) {
			this.selectedScopeIndex = nextIndex(this.selectedScopeIndex, SCOPE_OPTIONS.length);
		} else if (kb.matches(data, "tui.select.confirm")) {
			const scope = SCOPE_OPTIONS[this.selectedScopeIndex];
			if (!scope || !this.pendingItem || this.pendingValue === undefined) return;
			this.submitting = true;
			this.options.onChange(this.pendingItem, this.pendingValue, scope.id, this);
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.stage = "value";
		}
	}

	private confirmListItem(): void {
		const item = this.filteredItems[this.selectedIndex];
		if (!item) return;
		if (item.locked) {
			this.error = item.lockReason ?? "This setting is managed or unavailable.";
			return;
		}
		if (item.kind === "choice" && item.clientKey && item.allowedValues.length > 0) {
			this.pendingItem = item;
			const currentIndex = item.allowedValues.indexOf(item.value);
			this.selectedValueIndex = currentIndex >= 0 ? currentIndex : 0;
			this.stage = "value";
			this.searchInput.focused = false;
			return;
		}
		if (item.action || item.command) this.options.onAction(item, this);
	}

	private backToList(): void {
		this.stage = "list";
		this.pendingItem = undefined;
		this.pendingValue = undefined;
		this.searchInput.focused = this.focused;
	}

	private renderListStage(width: number): string[] {
		const category = CATEGORY_ORDER[this.categoryIndex] ?? "all";
		const categoryLabel = category === "all"
			? "All categories"
			: this.catalog.categories.find((item) => item.id === category)?.label ?? category;
		const lines = [
			theme.bold("Settings"),
			theme.fg("muted", `Category: ${categoryLabel} ${uiGlyphs().separator} Tab changes category ${uiGlyphs().separator} type to search`),
			"",
			...this.searchInput.render(width),
			"",
		];
		if (this.filteredItems.length === 0) {
			lines.push(theme.fg("muted", "  No matching settings"));
			return lines;
		}
		const maxVisible = 10;
		const start = Math.max(0, Math.min(this.selectedIndex - 4, this.filteredItems.length - maxVisible));
		const end = Math.min(start + maxVisible, this.filteredItems.length);
		for (let index = start; index < end; index += 1) {
			const item = this.filteredItems[index];
			if (item) lines.push(this.itemLine(item, index === this.selectedIndex, width, category === "all"));
		}
		if (start > 0 || end < this.filteredItems.length) {
			lines.push(theme.fg("muted", `  ${this.selectedIndex + 1}/${this.filteredItems.length}`));
		}
		const selected = this.filteredItems[this.selectedIndex];
		if (selected) {
			lines.push("", theme.fg("muted", `  ${selected.description}`));
			const flags = [
				selected.locked ? selected.lockReason ?? "locked" : undefined,
				selected.restartRequired ? "restart required" : undefined,
				selected.command,
			].filter(Boolean).join(` ${uiGlyphs().separator} `);
			if (flags) lines.push(theme.fg(selected.locked ? "warning" : "dim", `  ${flags}`));
		}
		lines.push("", `  ${keyHint("tui.select.confirm", "opens")}  ${keyHint("tui.select.cancel", "closes")}`);
		return lines;
	}

	private renderValueStage(width: number): string[] {
		const item = this.pendingItem;
		if (!item) return [];
		const lines = [
			theme.bold(`Choose ${item.label}`),
			theme.fg("muted", item.description),
			"",
		];
		for (let index = 0; index < item.allowedValues.length; index += 1) {
			const value = item.allowedValues[index] ?? "";
			const selected = index === this.selectedValueIndex;
			const current = value === item.value ? theme.fg("success", "  (current)") : "";
			lines.push(truncateToWidth(`${selected ? theme.fg("accent", `${uiGlyphs().selector} `) : "  "}${selected ? theme.fg("accent", value) : value}${current}`, width, "..."));
		}
		lines.push("", `  ${keyHint("tui.select.confirm", "continues")}  ${keyHint("tui.select.cancel", "returns to settings")}`);
		return lines;
	}

	private renderScopeStage(width: number): string[] {
		const item = this.pendingItem;
		if (!item || this.pendingValue === undefined) return [];
		const lines = [
			theme.bold("Review setting change"),
			theme.fg("muted", item.label),
			"",
			truncateToWidth(`  ${item.value}  ->  ${this.pendingValue}`, width, "..."),
			"",
		];
		SCOPE_OPTIONS.forEach((scope, index) => {
			const selected = index === this.selectedScopeIndex;
			const prefix = selected ? theme.fg("accent", `${uiGlyphs().selector} `) : "  ";
			const label = selected ? theme.fg("accent", scope.label) : scope.label;
			lines.push(truncateToWidth(`${prefix}${label}  ${theme.fg("muted", scope.description)}`, width, "..."));
		});
		lines.push("", `  ${keyHint("tui.select.confirm", "applies")}  ${keyHint("tui.select.cancel", "returns to values")}`);
		return lines;
	}

	private itemLine(item: MycliShellSettingsItem, selected: boolean, width: number, showCategory: boolean): string {
		const prefix = selected ? theme.fg("accent", `${uiGlyphs().selector} `) : "  ";
		const category = showCategory
			? `[${this.catalog.categories.find((entry) => entry.id === item.category)?.label ?? item.category}] `
			: "";
		const label = `${category}${item.label}`;
		const left = selected ? theme.fg("accent", label) : item.locked ? theme.fg("dim", label) : label;
		const source = width >= 72 ? ` ${uiGlyphs().separator} ${item.source}/${item.scope}` : "";
		const lock = item.locked ? ` ${uiGlyphs().separator} locked` : "";
		const meta = `${item.value}${source}${lock}`;
		const gap = Math.max(2, width - visibleWidth(prefix) - visibleWidth(label) - visibleWidth(meta));
		return truncateToWidth(`${prefix}${left}${" ".repeat(gap)}${theme.fg(item.locked ? "warning" : "muted", meta)}`, width, "...");
	}

	private applyFilter(): void {
		const category = CATEGORY_ORDER[this.categoryIndex] ?? "all";
		const query = this.searchInput.getValue().trim().toLowerCase();
		const tokens = query.split(/\s+/u).filter(Boolean);
		const categoryLabels = new Map(this.catalog.categories.map((item) => [item.id, `${item.label} ${item.description}`]));
		this.filteredItems = this.catalog.items.filter((item) => {
			if (category !== "all" && item.category !== category) return false;
			const haystack = [
				item.label, item.description, item.value, item.source, item.scope, item.command,
				categoryLabels.get(item.category), ...item.searchTerms,
			].filter(Boolean).join(" ").toLowerCase();
			return tokens.every((token) => haystack.includes(token));
		});
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
	}
}

function previousIndex(index: number, length: number): number {
	return length === 0 ? 0 : (index - 1 + length) % length;
}

function nextIndex(index: number, length: number): number {
	return length === 0 ? 0 : (index + 1) % length;
}

function fallbackSettingsCatalog(settings: MycliShellVisualSettings | undefined): MycliShellSettingsCatalog {
	const visual = {
		statusbarMode: "full",
		viewMode: "default",
		theme: "dark",
		hideThinking: true,
		toolDetailsDefault: "collapsed",
		hardwareCursor: false,
		clearOnShrink: true,
		terminalProgress: true,
		subagentDensity: "normal",
		colorMode: "auto",
		reducedMotion: false,
		glyphMode: "auto",
		highContrast: false,
		...settings,
	};
	const definitions: readonly [keyof MycliShellVisualSettings, string, string, string, readonly string[]][] = [
		["statusbarMode", "tui.statusbar_mode", "Statusbar", "Controls footer status density", ["off", "compact", "full"]],
		["viewMode", "tui.view_mode", "View mode", "Controls transcript detail density", ["default", "verbose", "focus"]],
		["theme", "tui.theme", "Theme", "Selects the terminal color theme", ["dark", "light"]],
		["hideThinking", "tui.hide_thinking", "Hide thinking", "Hides reasoning blocks", ["true", "false"]],
		["toolDetailsDefault", "tui.tool_details_default", "Tool details", "Controls completed tool detail expansion", ["collapsed", "expanded"]],
		["hardwareCursor", "tui.hardware_cursor", "Hardware cursor", "Uses the terminal cursor for IME placement", ["true", "false"]],
		["clearOnShrink", "tui.clear_on_shrink", "Clear on shrink", "Clears stale cells when the viewport shrinks", ["true", "false"]],
		["terminalProgress", "tui.terminal_progress", "Terminal progress", "Shows compact progress during a turn", ["true", "false"]],
		["subagentDensity", "tui.subagent_density", "Subagent detail", "Controls subagent summary density", ["compact", "normal", "detailed"]],
		["colorMode", "tui.color_mode", "Color mode", "Selects terminal color depth", ["auto", "truecolor", "256", "16", "none"]],
		["reducedMotion", "tui.reduced_motion", "Reduced motion", "Uses static progress indicators", ["true", "false"]],
		["glyphMode", "tui.glyph_mode", "Glyph mode", "Selects Unicode or ASCII interface glyphs", ["auto", "unicode", "ascii"]],
		["highContrast", "tui.high_contrast", "High contrast", "Uses stronger semantic contrast", ["true", "false"]],
	];
	return {
		version: 1,
		categories: [{ id: "appearance", label: "Appearance and accessibility", description: "Terminal presentation preferences" }],
		items: definitions.map(([clientKey, configKey, label, description, allowedValues]) => ({
			id: configKey,
			category: "appearance",
			kind: "choice",
			label,
			description,
			value: String(visual[clientKey]),
			source: "default",
			scope: "default",
			allowedValues: [...allowedValues],
			clientKey,
			configKey,
			locked: false,
			restartRequired: false,
			searchTerms: [clientKey],
		})),
	};
}
