import type { MycliShellSkill, MycliShellSkillCatalog, MycliShellSkillManager } from "../../model.ts";
import { Input, fuzzyFilter, getKeybindings, matchesKey, type Component, type Focusable } from "../../tui-core/index.ts";
import { theme } from "../../theme/theme.ts";
import { rawKeyHint } from "../shared/keybinding-hints.ts";
import { DecisionPanel, type DecisionPanelOptions } from "./decision-panel.ts";
import { decisionNavigationHints, type DecisionItem } from "./decision-list.ts";

type SkillView = "menu" | "select" | "manage";

interface SkillsSelectorOptions extends DecisionPanelOptions {
	readonly manager: MycliShellSkillManager;
	readonly onSelect: (skill: MycliShellSkill) => void;
	readonly onCancel: () => void;
}

export class SkillsSelectorComponent implements Component, Focusable {
	private readonly panel: DecisionPanel;
	private readonly search = new Input();
	private catalog?: MycliShellSkillCatalog;
	private view: SkillView = "menu";
	private index = 0;
	private loading = false;
	private busy = false;
	private disposed = false;
	private controller?: AbortController;
	private status = "";
	private failed = false;
	private hasFocus = false;

	constructor(private readonly options: SkillsSelectorOptions) {
		this.panel = new DecisionPanel(options);
		void this.load();
	}

	get focused(): boolean { return this.hasFocus; }
	set focused(value: boolean) { this.hasFocus = value; this.search.focused = value && this.view !== "menu"; }
	invalidate(): void { this.panel.invalidate(); }
	render(width: number): string[] { return this.panel.render(width); }
	dispose(): void { this.disposed = true; this.controller?.abort(); }

	handleInput(data: string): void {
		if (this.disposed || this.panel.handleInput(data)) return;
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.cancel")) {
			if (this.view === "menu" || this.busy) { this.dispose(); this.options.onCancel(); }
			else { this.view = "menu"; this.index = 0; this.status = ""; this.failed = false; this.update(); }
			return;
		}
		if (this.busy) return;
		if (matchesKey(data, "ctrl+r")) { void this.load(); return; }
		const length = this.view === "menu" ? 2 : this.skills().length;
		if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
			const offset = keys.matches(data, "tui.select.up") ? -1 : 1;
			this.index = length ? (this.index + offset + length) % length : 0;
		} else if (keys.matches(data, "tui.select.confirm") || this.view === "manage" && data === " ") {
			if (this.view === "menu") { this.view = this.index === 0 ? "select" : "manage"; this.index = 0; }
			else if (!this.loading && !this.failed) {
				const skill = this.skills()[this.index];
				if (skill && this.view === "select") { this.dispose(); this.options.onSelect(skill); return; }
				if (skill) { void this.toggle(skill); return; }
			}
		} else if (this.view !== "menu") {
			this.search.handleInput(data); this.index = 0;
		}
		this.update();
	}

	private skills(): MycliShellSkill[] {
		const skills = (this.catalog?.skills ?? []).filter((skill) => this.view !== "select" || skill.enabled);
		return fuzzyFilter(skills, this.search.getValue(), (skill) => `${skill.name} ${skill.description} ${skill.source} ${skill.path}`);
	}

	private async load(): Promise<void> {
		this.controller?.abort();
		const controller = new AbortController(); this.controller = controller;
		const selected = this.skills()[this.index]?.id;
		this.loading = true; this.failed = false; this.status = ""; this.update();
		try {
			const catalog = await this.options.manager.load(controller.signal);
			if (this.disposed || controller.signal.aborted) return;
			this.catalog = catalog;
			if (this.view !== "menu") this.index = Math.max(0, this.skills().findIndex((skill) => skill.id === selected));
		} catch {
			if (this.disposed || controller.signal.aborted) return;
			this.failed = true; this.status = "Could not load skills. Ctrl+R to retry.";
		} finally {
			if (!this.disposed && !controller.signal.aborted) { this.loading = false; this.update(); }
		}
	}

	private async toggle(skill: MycliShellSkill): Promise<void> {
		if (!this.catalog || this.busy) return;
		this.controller?.abort();
		const controller = new AbortController(); this.controller = controller;
		this.busy = true; this.failed = false; this.status = "Saving skill settings…"; this.update();
		try {
			const catalog = await this.options.manager.setEnabled(skill, !skill.enabled, this.catalog.revision, controller.signal);
			if (this.disposed || controller.signal.aborted) return;
			this.catalog = catalog;
			this.index = Math.max(0, this.skills().findIndex((item) => item.id === skill.id));
			this.status = `${skill.enabled ? "Disabled" : "Enabled"} ${safe(skill.name)}. Applies to subsequent turns.`;
		} catch {
			if (this.disposed || controller.signal.aborted) return;
			this.failed = true; this.status = "Could not save skill settings. Ctrl+R to refresh and retry.";
		} finally {
			if (!this.disposed && !controller.signal.aborted) { this.busy = false; this.update(); }
		}
	}

	private update(): void {
		if (this.disposed) return;
		const skills = this.skills();
		const skill = skills[this.index];
		const menu = this.view === "menu";
		const items: DecisionItem[] = menu ? [
			{ label: "List skills", description: "Choose a skill to include in your message" },
			{ label: "Enable/Disable Skills", description: "Choose which skills are available" },
		] : this.loading || this.failed ? [] : skills.map((item) => ({
			label: `${this.view === "manage" ? `[${item.enabled ? "x" : " "}] ` : ""}${safe(item.name)}`,
			description: safe(item.description),
		}));
		this.focused = this.hasFocus;
		this.panel.setContent({ title: theme.bold(menu ? "Skills" : this.view === "manage" ? "Enable/Disable Skills" : "Select a skill"),
			preview: menu ? undefined : this.search,
			details: menu ? ["Choose an action"] : [
				this.loading ? "Loading skills…" : `${skills.length} skills`,
				...(this.view === "manage" ? ["Changes are saved automatically and apply to subsequent turns."] : []),
				...(!this.loading && !skills.length ? [this.search.getValue() ? "No matching skills." : this.view === "manage" ? "No skills found." : "No enabled skills. Enable skills from the management menu."] : []),
				...(skill ? [`${safe(skill.source)} · ${safe(skill.path)}`] : []),
			], items, selectedIndex: this.index, busy: this.busy,
			status: this.failed ? theme.fg("error", this.status) : theme.fg("muted", this.status),
			hints: [...decisionNavigationHints(), ...(!menu ? [rawKeyHint("ctrl+r", "refresh")] : []),
				...(this.view === "manage" ? [rawKeyHint("space", "enable/disable")] : [])],
		});
	}
}

function safe(value: string): string { return value.replace(/[\p{Cc}\p{Cf}]/gu, " "); }
