import type { PluginCatalog, PluginCatalogEntry, PluginChange, PluginDetail } from "@mycli/contracts";
import type { MycliShellPluginManager } from "../../model.ts";
import { Input, getKeybindings, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable } from "../../tui-core/index.ts";
import { theme } from "../../theme/theme.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { rawKeyHint } from "../shared/keybinding-hints.ts";
import { DecisionPanel, type DecisionPanelOptions } from "./decision-panel.ts";
import { decisionNavigationHints, nextDecisionIndex, type DecisionItem } from "./decision-list.ts";
import { ADD_MARKETPLACE_TAB, ALL_PLUGINS_TAB, INSTALLED_PLUGINS_TAB, filterPlugins, marketplaceActions,
	marketplaceTab, pluginActions, pluginDetails, pluginStatus, tabMarketplace, type PluginAction } from "./plugin-selector-model.ts";

type View = "list" | "detail" | "marketplace" | "source" | "confirm";
interface PluginSelectorOptions extends DecisionPanelOptions {
	readonly manager: MycliShellPluginManager;
	readonly onCancel: () => void;
}

/** A single selector owns list/detail state and cancellation across its whole lifetime. */
export class PluginSelectorComponent implements Component, Focusable {
	private readonly panel: DecisionPanel;
	private readonly searchInput = new Input();
	private readonly sourceInput = new Input();
	private catalog?: PluginCatalog;
	private tab = ALL_PLUGINS_TAB;
	private view: View = "list";
	private listIndex = 0;
	private actionIndex = 0;
	private detailId?: string;
	private detail?: PluginDetail;
	private detailController?: AbortController;
	private detailLoading = false;
	private detailFailed = false;
	private sourceKind: "install_source" | "marketplace_add" = "marketplace_add";
	private confirmation?: PluginAction;
	private confirmationBack: View = "detail";
	private loading = false;
	private loadFailed = false;
	private busy = false;
	private disposed = false;
	private loadRevision = 0;
	private loadController?: AbortController;
	private operationController?: AbortController;
	private status = "";
	private error = false;
	private _focused = false;

	constructor(private readonly options: PluginSelectorOptions) {
		this.panel = new DecisionPanel(options);
		void this.load();
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value && this.view === "list";
		this.sourceInput.focused = value && this.view === "source";
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.loadController?.abort();
		this.detailController?.abort();
		this.operationController?.abort();
	}

	invalidate(): void { this.panel.invalidate(); }
	render(width: number): string[] { return this.panel.render(width); }

	handleInput(data: string): void {
		if (this.disposed || this.panel.handleInput(data)) return;
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.view === "detail") this.detailController?.abort();
			if (this.busy || this.view === "list") { this.dispose(); this.options.onCancel(); }
			else if (this.view === "confirm") { this.view = this.confirmationBack; this.actionIndex = 0; this.update(); }
			else {
				const leavingSource = this.view === "source";
				this.view = "list"; this.tab = this.tab === ADD_MARKETPLACE_TAB ? ALL_PLUGINS_TAB : this.tab;
				if (leavingSource) void this.load(); else this.update();
			}
			return;
		}
		if (this.busy) return;
		if (matchesKey(data, "ctrl+r")) { void this.load(); return; }
		if (this.loading && this.view !== "list" && this.view !== "source") return;
		if (this.view === "source") {
			if (kb.matches(data, "tui.select.confirm")) {
				const source = this.sourceInput.getValue().trim();
				if (!source || source.length > 4096 || /[\p{Cc}\p{Cf}]/u.test(source)) {
					this.status = "Enter a local directory or Git URL (up to 4096 characters)."; this.error = true; this.update(); return;
				}
				this.confirmationBack = "source";
				this.confirmation = { label: this.sourceKind === "marketplace_add" ? "Add marketplace" : "Install plugin",
					change: { action: this.sourceKind, source }, confirmation: `Source: ${source}` };
				this.view = "confirm"; this.actionIndex = 0;
			} else this.sourceInput.handleInput(data);
			this.update(); return;
		}
		if (this.view === "list") {
			if (matchesKey(data, "left") || matchesKey(data, "right") || kb.matches(data, "tui.input.tab")) {
				const tabs = this.tabs();
				const next = (tabs.findIndex((tab) => tab.id === this.tab) + (matchesKey(data, "left") ? -1 : 1) + tabs.length) % tabs.length;
				this.tab = tabs[next]?.id ?? ALL_PLUGINS_TAB;
				this.listIndex = 0;
				if (this.tab === ADD_MARKETPLACE_TAB) this.openSource("marketplace_add");
				else void this.load();
				return;
			}
			if (matchesKey(data, "ctrl+n")) { this.openSource("install_source"); return; }
			if (this.loading || this.loadFailed) return;
			const items = this.listItems();
			if (kb.matches(data, "tui.select.up")) this.listIndex = nextDecisionIndex(items, this.listIndex, -1);
			else if (kb.matches(data, "tui.select.down")) this.listIndex = nextDecisionIndex(items, this.listIndex, 1);
			else if (matchesKey(data, "home")) this.listIndex = 0;
			else if (matchesKey(data, "end")) this.listIndex = Math.max(0, items.length - 1);
			else if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
				this.listIndex = Math.max(0, Math.min(items.length - 1, this.listIndex + (matchesKey(data, "pageUp") ? -10 : 10)));
			} else if (kb.matches(data, "tui.select.confirm")) this.openSelected();
			else if (data === " " && !this.searchInput.getValue()) {
				const plugin = this.selectedPlugin();
				const toggle = plugin && pluginActions(plugin).find((item) => item.change?.action === "enable" || item.change?.action === "disable");
				if (toggle?.change) void this.change(toggle.change);
			} else {
				this.searchInput.handleInput(data); this.listIndex = 0;
			}
		} else {
			const actions = this.actions();
			if (kb.matches(data, "tui.select.up")) this.actionIndex = nextDecisionIndex(actions, this.actionIndex, -1);
			else if (kb.matches(data, "tui.select.down")) this.actionIndex = nextDecisionIndex(actions, this.actionIndex, 1);
			else if (kb.matches(data, "tui.select.confirm")) {
				const action = actions[this.actionIndex];
				if (action?.change) {
					if (action.confirmation && this.view !== "confirm") {
						this.confirmationBack = this.view; this.confirmation = action; this.view = "confirm"; this.actionIndex = 0;
					} else void this.change(action.change);
				} else if (this.view === "confirm") { this.view = this.confirmationBack; this.actionIndex = 0; }
				else this.view = "list";
			}
		}
		this.update();
	}

	private tabs(): { id: string; label: string }[] {
		return [{ id: ALL_PLUGINS_TAB, label: "All Plugins" }, { id: INSTALLED_PLUGINS_TAB, label: "Installed" },
			...(this.catalog?.marketplaces ?? []).map((item) => ({ id: marketplaceTab(item.name), label: item.name })),
			{ id: ADD_MARKETPLACE_TAB, label: "Add Marketplace" }];
	}

	private plugins(): PluginCatalogEntry[] { return filterPlugins(this.catalog, this.tab, this.searchInput.getValue()); }
	private selectedPlugin(): PluginCatalogEntry | undefined {
		return this.plugins()[this.listIndex - (tabMarketplace(this.tab) ? 1 : 0)];
	}
	private listItems(): DecisionItem[] {
		const plugins = this.plugins();
		return [...(tabMarketplace(this.tab) ? [{ label: "Manage marketplace", description: "Refresh or remove this catalog" }] : []),
			...plugins.map((plugin) => ({ label: `[${plugin.installed ? plugin.enabled ? "x" : " " : "-"}] ${safe(plugin.name)}`,
				description: [pluginStatus(plugin), plugin.marketplace, plugin.description].filter(Boolean).map((text) => safe(text!)).join(` ${uiGlyphs().separator} `) })),
			...(!plugins.length ? [{ label: "Install from source", description: "Local directory or Git repository" }, { label: "Add marketplace" }] : [])];
	}

	private openSelected(): void {
		if (tabMarketplace(this.tab) && this.listIndex === 0) { this.view = "marketplace"; this.actionIndex = 0; return; }
		const plugin = this.selectedPlugin();
		if (plugin) { this.detailId = plugin.id; this.view = "detail"; this.actionIndex = 0; void this.loadDetail(plugin); return; }
		const offset = this.listIndex - (tabMarketplace(this.tab) ? 1 : 0);
		this.openSource(offset === 0 ? "install_source" : "marketplace_add");
	}

	private openSource(kind: "install_source" | "marketplace_add"): void {
		this.loadController?.abort(); this.loading = false;
		this.sourceKind = kind; this.sourceInput.setValue(""); this.view = "source";
		this.status = ""; this.error = false; this.update();
	}

	private actions(): PluginAction[] {
		if (this.view === "detail" && (this.detailLoading || this.detailFailed)) return [{ label: "Back to plugins" }];
		if (this.loadFailed && this.view !== "source" && this.view !== "confirm") return [{ label: "Back to plugins" }];
		if (this.view === "confirm") return [{ label: "Cancel" }, ...(this.confirmation ? [this.confirmation] : [])];
		if (this.view === "detail") {
			const plugin = this.catalog?.plugins.find((item) => item.id === this.detailId);
			return plugin ? pluginActions(plugin) : [{ label: "Back to plugins" }];
		}
		const market = this.catalog?.marketplaces.find((item) => item.name === tabMarketplace(this.tab));
		return market ? marketplaceActions(market) : [{ label: "Back to plugins" }];
	}

	private async load(): Promise<void> {
		const revision = ++this.loadRevision;
		const selectedId = this.selectedPlugin()?.id;
		this.loadController?.abort();
		const controller = new AbortController(); this.loadController = controller;
		if (this.loadFailed) { this.status = ""; this.error = false; }
		this.loading = true; this.loadFailed = false; this.update();
		try {
			const catalog = await this.options.manager.load(controller.signal, tabMarketplace(this.tab));
			if (this.disposed || controller.signal.aborted || revision !== this.loadRevision) return;
			this.catalog = catalog;
			if (!this.tabs().some((item) => item.id === this.tab)) {
				this.tab = ALL_PLUGINS_TAB; this.view = "list"; await this.load(); return;
			}
			const selected = this.plugins().findIndex((item) => item.id === selectedId);
			this.listIndex = selected >= 0 ? selected + (tabMarketplace(this.tab) ? 1 : 0) : Math.min(this.listIndex, Math.max(0, this.listItems().length - 1));
			if (this.view === "detail" && !catalog.plugins.some((item) => item.id === this.detailId)) this.view = "list";
			if (this.view === "marketplace" && !tabMarketplace(this.tab)) this.view = "list";
			const plugin = this.view === "detail" ? catalog.plugins.find((item) => item.id === this.detailId) : undefined;
			if (plugin) await this.loadDetail(plugin);
		} catch {
			if (this.disposed || controller.signal.aborted || revision !== this.loadRevision) return;
			this.loadFailed = true; this.status = "Could not load plugins. Ctrl+R to retry."; this.error = true;
		} finally {
			if (!this.disposed && revision === this.loadRevision && !controller.signal.aborted) { this.loading = false; this.update(); }
		}
	}

	private async loadDetail(plugin: PluginCatalogEntry): Promise<void> {
		this.detailController?.abort();
		this.detail = undefined; this.detailFailed = false; this.detailLoading = false;
		if (!this.options.manager.inspect) return;
		const controller = new AbortController(); this.detailController = controller;
		this.detailLoading = true; this.update();
		try {
			const detail = await this.options.manager.inspect(plugin, controller.signal);
			if (controller.signal.aborted || this.disposed || this.view !== "detail" || this.detailId !== plugin.id) return;
			if (detail.plugin.id !== plugin.id || detail.plugin.revision !== plugin.revision) this.detailFailed = true;
			else this.detail = detail;
		} catch {
			if (controller.signal.aborted || this.disposed) return;
			this.detailFailed = true;
		} finally {
			if (!this.disposed && !controller.signal.aborted) { this.detailLoading = false; this.update(); }
		}
	}

	private async change(change: PluginChange): Promise<void> {
		if (this.busy || this.loading || this.disposed) return;
		const controller = new AbortController(); this.operationController = controller;
		const previousMarkets = new Set(this.catalog?.marketplaces.map((item) => item.name));
		this.busy = true; this.status = `Updating plugin packages${uiGlyphs().ellipsis} Esc closes and cancels pending work.`; this.error = false; this.update();
		try {
			const result = await this.options.manager.change(change, controller.signal);
			if (this.disposed) return;
			this.status = [result.message, ...result.issues].join("\n"); this.error = result.state === "failed";
			if (this.view === "confirm") this.view = this.confirmationBack;
			if (result.state === "completed") {
				if (change.action === "marketplace_add" || change.action === "install_source") { this.view = "list"; this.tab = ALL_PLUGINS_TAB; }
				if (change.action === "remove" || change.action === "marketplace_remove") this.view = "list";
			}
			this.actionIndex = 0;
			await this.load();
			if (result.state === "completed" && change.action === "marketplace_add" && !this.disposed) {
				const added = this.catalog?.marketplaces.find((item) => !previousMarkets.has(item.name));
				if (added) { this.tab = marketplaceTab(added.name); this.searchInput.setValue(""); await this.load(); }
			}
		} catch {
			if (this.disposed) return;
			this.status = "Plugin operation could not be confirmed. Refresh the list to check its result before trying again."; this.error = true;
		} finally { if (!this.disposed) { this.busy = false; this.update(); } }
	}

	private update(): void {
		if (this.disposed) return;
		this.focused = this._focused;
		let title = "Plugins";
		let details: string[] = [];
		let preview: Component | undefined;
		let items: readonly DecisionItem[];
		let hints = decisionNavigationHints(this.view === "list" ? "details" : "confirm", this.view === "list" ? "close" : "back");
		if (this.view === "list") {
			preview = { invalidate() {}, render: (width) => {
				const tabs = this.tabs();
				const labels = tabs.map((item) => item.id === this.tab ? theme.fg("accent", `[${safe(item.label)}]`) : theme.fg("muted", safe(item.label)));
				const current = labels[tabs.findIndex((item) => item.id === this.tab)] ?? "";
				return [visibleWidth(labels.join("  ")) <= width ? labels.join("  ") : truncateToWidth(current, width, ""),
					...this.searchInput.render(width)];
			} };
			details = [this.loading ? `Loading plugins${uiGlyphs().ellipsis}` : `${this.plugins().length} plugins ${uiGlyphs().separator} Type to search`,
				...(!this.loading && !this.plugins().length ? [this.searchInput.getValue() ? "No matching plugins." : "No plugins found. Add a marketplace or install a local plugin."] : []),
				...(this.catalog?.truncated ? ["Combined catalog is limited. Select a marketplace to browse its complete list."] : []),
				...(this.catalog?.repository_enabled === false ? ["Workspace plugins are hidden until this workspace is trusted."] : []),
				...(this.catalog?.issues ?? []).map((issue) => `Issue: ${issue}`),
				...(this.catalog?.marketplaces ?? []).flatMap((item) => item.issues.map((issue) => `${item.name}: ${issue}`))];
			items = this.loading || this.loadFailed ? [] : this.listItems();
			hints = [...hints, rawKeyHint("left/right", "marketplace"), ...(!this.searchInput.getValue() ? [rawKeyHint("space", "enable/disable")] : []), rawKeyHint("ctrl+n", "install source"), rawKeyHint("ctrl+r", "refresh")];
		} else if (this.view === "source") {
			title = this.sourceKind === "marketplace_add" ? "Add marketplace" : "Install plugin from source";
			details = ["Enter a local directory, Git URL or owner/repository. Enter reviews the source."];
			preview = this.sourceInput; items = [];
		} else if (this.view === "confirm") {
			title = this.confirmation?.label ?? "Confirm plugin change";
			details = [this.confirmation?.confirmation ?? ""];
			items = this.actions();
		} else if (this.view === "detail") {
			const plugin = this.catalog?.plugins.find((item) => item.id === this.detailId);
			title = plugin ? `Plugins ${uiGlyphs().separator} ${safe(plugin.name)}` : "Plugins";
			details = plugin ? [...pluginDetails(plugin), ...(this.detail?.details ?? [])] : ["Plugin is no longer available. Refresh the list."];
			if (this.detailLoading) details.unshift(`Loading plugin details${uiGlyphs().ellipsis}`);
			if (this.detailFailed) details.unshift("Plugin details could not be loaded or the selection changed. Ctrl+R to refresh.");
			items = this.actions();
		} else {
			const market = this.catalog?.marketplaces.find((item) => item.name === tabMarketplace(this.tab));
			title = `Marketplace ${uiGlyphs().separator} ${safe(market?.name ?? "")}`;
			details = market ? [`Source: ${market.source}`, "Refreshing updates the catalog. Installed plugins are updated separately.", ...market.issues.map((issue) => `Issue: ${issue}`)] : [];
			items = this.actions();
		}
		if (this.busy) hints = [rawKeyHint("esc", "close and cancel")];
		this.panel.setContent({ title, details: details.map(safe), ...(preview ? { preview } : {}), items,
			selectedIndex: this.view === "list" ? this.listIndex : this.actionIndex, hints, busy: this.busy || this.loading,
			...(this.status ? { status: theme.fg(this.error ? "warning" : "muted", safe(this.status)) } : {}) });
	}
}

function safe(text: string): string { return text.replace(/[\p{Cc}\p{Cf}]/gu, " "); }
