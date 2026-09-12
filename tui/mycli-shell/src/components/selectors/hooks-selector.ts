import type { MycliShellHook, MycliShellHookCatalog, MycliShellHookManager } from "../../model.ts";
import { Input, fuzzyFilter, getKeybindings, matchesKey, type Component, type Focusable } from "../../tui-core/index.ts";
import { theme } from "../../theme/theme.ts";
import { rawKeyHint } from "../shared/keybinding-hints.ts";
import { DecisionPanel, type DecisionPanelOptions } from "./decision-panel.ts";
import { decisionNavigationHints, type DecisionItem } from "./decision-list.ts";

interface HooksSelectorOptions extends DecisionPanelOptions {
	readonly manager: MycliShellHookManager;
	readonly onCancel: () => void;
}

export class HooksSelectorComponent implements Component, Focusable {
	private readonly panel: DecisionPanel;
	private readonly search = new Input();
	private catalog?: MycliShellHookCatalog;
	private point?: string;
	private selected?: MycliShellHook;
	private confirmingTrust = false;
	private index = 0;
	private loading = false;
	private busy = false;
	private failed = false;
	private disposed = false;
	private controller?: AbortController;
	private status = "";
	private hasFocus = false;

	constructor(private readonly options: HooksSelectorOptions) {
		this.panel = new DecisionPanel(options);
		void this.load();
	}

	get focused(): boolean { return this.hasFocus; }
	set focused(value: boolean) { this.hasFocus = value; this.search.focused = value && !this.selected; }
	invalidate(): void { this.panel.invalidate(); }
	render(width: number): string[] { return this.panel.render(width); }
	dispose(): void { this.disposed = true; this.controller?.abort(); }

	handleInput(data: string): void {
		if (this.disposed || this.panel.handleInput(data)) return;
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.cancel")) {
			if (this.busy || !this.point) { this.dispose(); this.options.onCancel(); return; }
			if (this.confirmingTrust) this.confirmingTrust = false;
			else if (this.selected) this.selected = undefined;
			else { this.point = undefined; this.search.setValue(""); }
			this.index = 0; this.update(); return;
		}
		if (this.busy) return;
		if (matchesKey(data, "ctrl+r")) { void this.load(); return; }
		const length = this.items().length;
		if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
			const offset = keys.matches(data, "tui.select.up") ? -1 : 1;
			this.index = length ? (this.index + offset + length) % length : 0;
		} else if (keys.matches(data, "tui.select.confirm") && !this.loading && !this.failed) {
			if (this.selected) {
				if (this.confirmingTrust) {
					if (this.index === 1) { void this.write("trust"); return; }
					this.confirmingTrust = false;
				} else if (this.index === 0) { void this.write(this.selected.enabled ? "disable" : "enable"); return; }
				else if (this.selected.trustSource === "allowlist") {
					if (this.selected.trusted) { void this.write("revoke"); return; }
					this.confirmingTrust = true;
				}
			} else if (this.point) this.selected = this.hooks()[this.index];
			else this.point = this.points()[this.index];
			this.index = 0;
		} else if (!this.selected) { this.search.handleInput(data); this.index = 0; }
		this.update();
	}

	private hooks(): MycliShellHook[] {
		return fuzzyFilter((this.catalog?.hooks ?? []).filter((hook) => !this.point || hook.point === this.point),
			this.search.getValue(), (hook) => `${hook.name} ${hook.point} ${hook.source} ${hook.path}`);
	}

	private points(): string[] { return [...new Set(this.hooks().map((hook) => hook.point))]; }

	private items(): DecisionItem[] {
		if (this.loading || this.failed) return [];
		if (this.confirmingTrust) return [{ label: "Cancel" }, { label: "Trust this command", description: "Allow this exact command to run automatically for this event" }];
		if (this.selected) return [
			{ label: this.selected.enabled ? "Disable hook" : "Enable hook" },
			...(this.selected.trustSource === "allowlist" ? [{ label: this.selected.trusted ? "Revoke trust" : "Review and trust command" }] : []),
		];
		return this.point ? this.hooks().map((hook) => ({ label: `${hook.enabled ? "[x]" : "[ ]"} ${safe(hook.name)}`,
			description: `${safe(hook.source)} · ${hook.trusted ? "trusted" : "needs trust"}` }))
			: this.points().map((point) => ({ label: point, description: `${this.hooks().filter((hook) => hook.point === point).length} hooks` }));
	}

	private async load(): Promise<void> {
		this.controller?.abort();
		const controller = new AbortController(); this.controller = controller;
		this.loading = true; this.failed = false; this.status = ""; this.update();
		try {
			const catalog = await this.options.manager.load(controller.signal);
			if (this.disposed || controller.signal.aborted) return;
			this.catalog = catalog;
			if (this.selected) this.selected = catalog.hooks.find((hook) => hook.id === this.selected?.id);
			this.confirmingTrust = false; this.index = 0;
		} catch {
			if (this.disposed || controller.signal.aborted) return;
			this.failed = true; this.status = "Could not load hooks. Ctrl+R to retry.";
		} finally {
			if (!this.disposed && !controller.signal.aborted) { this.loading = false; this.update(); }
		}
	}

	private async write(action: "enable" | "disable" | "trust" | "revoke"): Promise<void> {
		if (!this.selected || !this.catalog || this.busy) return;
		const selectedId = this.selected.id;
		this.controller?.abort();
		const controller = new AbortController(); this.controller = controller;
		this.busy = true; this.status = "Saving hook settings…"; this.update();
		try {
			const catalog = await this.options.manager.write(this.selected, action, this.catalog.revision, controller.signal);
			if (this.disposed || controller.signal.aborted) return;
			this.catalog = catalog;
			this.selected = catalog.hooks.find((hook) => hook.id === selectedId);
			this.confirmingTrust = false; this.index = 0;
			this.status = "Saved. Availability applies to subsequent turns.";
		} catch {
			if (this.disposed || controller.signal.aborted) return;
			this.failed = true; this.status = "Could not save hook settings. Ctrl+R to refresh and retry.";
		} finally {
			if (!this.disposed && !controller.signal.aborted) { this.busy = false; this.update(); }
		}
	}

	private update(): void {
		if (this.disposed) return;
		const hook = this.selected;
		this.focused = this.hasFocus;
		this.panel.setContent({ title: theme.bold(this.confirmingTrust ? "Trust hook command" : hook ? `Hook · ${safe(hook.name)}` : this.point ? `Hooks · ${this.point}` : "Hooks"),
			preview: hook ? undefined : this.search,
			details: hook ? [
				...(hook.command.length ? [`$ ${hook.command.map((part) => /^[a-zA-Z0-9_./:-]+$/u.test(part) ? part : JSON.stringify(part)).join(" ")}`] : ["Plugin handler"]),
				`Event: ${hook.point} · ${hook.enabled ? "enabled" : "disabled"}`,
				`Source: ${safe(hook.source)} · ${safe(hook.path)}`,
				hook.trustSource === "plugin" ? "Trusted through the enabled plugin. Manage plugin trust in /plugins." : `Trust: ${hook.trusted ? "allowed" : "required before execution"}`,
				...(hook.timeoutMs ? [`Timeout: ${hook.timeoutMs} ms`] : []),
			] : [this.loading ? "Loading hooks…" : this.hooks().length ? "Select an event or search hooks" : "No matching hooks."],
			items: this.items(), selectedIndex: this.index, busy: this.busy, tone: this.confirmingTrust ? "warning" : "accent",
			status: theme.fg(this.failed ? "error" : "muted", this.status),
			hints: [...decisionNavigationHints(), rawKeyHint("ctrl+r", "refresh")],
		});
	}
}

function safe(value: string): string { return value.replace(/[\p{Cc}\p{Cf}]/gu, " "); }
