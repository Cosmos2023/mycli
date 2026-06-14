import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Spacer,
	Text,
	type TUI,
} from "../tui-core/index.ts";
import type { MycliShellModel } from "../model.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

type ModelScope = "all" | "scoped";
type ThinkingLevel = "low" | "medium" | "high" | "xhigh";

const THINKING_LEVELS: ThinkingLevel[] = ["low", "medium", "high", "xhigh"];

type ModelItem = {
	provider: string;
	id: string;
	name: string;
	model: MycliShellModel;
};

export type ModelSelectorOptions = {
	tui: TUI;
	currentModel?: MycliShellModel;
	models: MycliShellModel[];
	onSelect: (model: MycliShellModel) => void;
	onCancel: () => void;
	initialSearchInput?: string;
};

function modelsAreEqual(a: MycliShellModel | undefined, b: MycliShellModel | undefined): boolean {
	return Boolean(a && b && a.provider === b.provider && a.id === b.id);
}

export class ModelSelectorComponent extends Container implements Focusable {
	private readonly searchInput = new Input();
	private readonly listContainer = new Container();
	private readonly tui: TUI;
	private readonly currentModel?: MycliShellModel;
	private readonly allModels: ModelItem[];
	private readonly scopedModelItems: ModelItem[];
	private activeModels: ModelItem[];
	private filteredModels: ModelItem[];
	private selectedIndex = 0;
	private thinkingLevel: ThinkingLevel;
	private scope: ModelScope;
	private scopeText?: Text;
	private scopeHintText?: Text;
	private thinkingText: Text;
	private thinkingHintText: Text;
	private readonly onSelectCallback: (model: MycliShellModel) => void;
	private readonly onCancelCallback: () => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(options: ModelSelectorOptions) {
		super();
		this.tui = options.tui;
		this.currentModel = options.currentModel;
		this.allModels = this.sortModels(options.models.map((model) => this.toItem(model)));
		this.scopedModelItems = this.allModels.filter((item) => item.model.scoped);
		this.scope = this.scopedModelItems.length > 0 ? "scoped" : "all";
		this.thinkingLevel = thinkingLevelFromModel(options.currentModel);
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.filteredModels = this.activeModels;
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		if (this.scopedModelItems.length > 0) {
			this.scopeText = new Text(this.getScopeText(), 0, 0);
			this.addChild(this.scopeText);
			this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
			this.addChild(this.scopeHintText);
		} else {
			this.addChild(new Text(theme.fg("warning", "Only showing models from configured providers."), 0, 0));
		}
		this.addChild(new Spacer(1));
		this.thinkingText = new Text(this.getThinkingText(), 0, 0);
		this.thinkingHintText = new Text(this.getThinkingHintText(), 0, 0);
		this.addChild(this.thinkingText);
		this.addChild(this.thinkingHintText);
		this.addChild(new Spacer(1));

		if (options.initialSearchInput) {
			this.searchInput.setValue(options.initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			const selected = this.filteredModels[this.selectedIndex];
			if (selected) {
				this.handleSelect(selected.model);
			}
		};
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		if (options.initialSearchInput) {
			this.filterModels(options.initialSearchInput);
		} else {
			this.updateList();
		}
	}

	private toItem(model: MycliShellModel): ModelItem {
		return {
			provider: model.provider,
			id: model.id,
			name: model.name ?? model.id,
			model,
		};
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		return [...models].sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
		});
	}

	private getScopeText(): string {
		const allText = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
		const scopedText = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
		return `${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText}`;
	}

	private getScopeHintText(): string {
		return keyHint("tui.input.tab", "scope") + theme.fg("muted", " (all/scoped)");
	}

	private getThinkingText(): string {
		const parts = THINKING_LEVELS.map((level) =>
			level === this.thinkingLevel ? theme.getThinkingBorderColor(level)(level) : theme.fg("muted", level),
		);
		return `${theme.fg("muted", "Thinking: ")}${parts.join(theme.fg("muted", " | "))}`;
	}

	private getThinkingHintText(): string {
		return theme.fg("muted", "left/right thinking effort");
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		const currentIndex = this.activeModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		this.filterModels(this.searchInput.getValue());
		this.scopeText?.setText(this.getScopeText());
	}

	private setThinkingLevel(level: ThinkingLevel): void {
		if (this.thinkingLevel === level) return;
		this.thinkingLevel = level;
		this.thinkingText.setText(this.getThinkingText());
		this.thinkingHintText.setText(this.getThinkingHintText());
	}

	private cycleThinking(delta: number): void {
		const currentIndex = Math.max(0, THINKING_LEVELS.indexOf(this.thinkingLevel));
		const nextIndex = (currentIndex + delta + THINKING_LEVELS.length) % THINKING_LEVELS.length;
		this.setThinkingLevel(THINKING_LEVELS[nextIndex]!);
	}

	private filterModels(query: string): void {
		this.filteredModels = query
			? fuzzyFilter(this.activeModels, query, ({ id, provider }) => `${id} ${provider} ${provider}/${id}`)
			: this.activeModels;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

		for (let index = startIndex; index < endIndex; index += 1) {
			const item = this.filteredModels[index];
			if (!item) continue;
			const isSelected = index === this.selectedIndex;
			const isCurrent = modelsAreEqual(this.currentModel, item.model);
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const modelText = isSelected ? theme.fg("accent", item.id) : item.id;
			const providerBadge = theme.fg("muted", `[${item.provider}]`);
			const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
			this.listContainer.addChild(new Text(`${prefix}${modelText} ${providerBadge}${checkmark}`, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredModels.length) {
			this.listContainer.addChild(new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`), 0, 0));
		}

		if (this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
			return;
		}

		const selected = this.filteredModels[this.selectedIndex];
		if (selected) {
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(theme.fg("muted", `  Model Name: ${selected.name}`), 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.scopedModelItems.length > 0) {
				this.setScope(this.scope === "all" ? "scoped" : "all");
				this.scopeHintText?.setText(this.getScopeHintText());
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}
		if (keyData === "\x1b[C") {
			this.cycleThinking(1);
			return;
		}
		if (keyData === "\x1b[D") {
			this.cycleThinking(-1);
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredModels[this.selectedIndex];
			if (selected) {
				this.handleSelect(selected.model);
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}

		this.searchInput.handleInput(keyData);
		this.filterModels(this.searchInput.getValue());
		this.tui.requestRender();
	}

	private handleSelect(model: MycliShellModel): void {
		this.onSelectCallback({ ...model, thinkingLevel: this.thinkingLevel });
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}

function thinkingLevelFromModel(model: MycliShellModel | undefined): ThinkingLevel {
	const value = model?.thinkingLevel;
	return value === "low" || value === "high" || value === "xhigh" ? value : "medium";
}
