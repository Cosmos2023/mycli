import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	truncateToWidth,
	type TUI,
} from "../tui-core/index.ts";
import type { MycliShellModel } from "../model.ts";
import { theme } from "../theme/theme.ts";

type SelectorStage = "model" | "reasoning";

export type ModelSelectorOptions = {
	tui: TUI;
	currentModel?: MycliShellModel;
	models: MycliShellModel[];
	onSelect: (model: MycliShellModel) => void;
	onCancel: () => void;
	initialSearchInput?: string;
};

function modelsAreEqual(a: MycliShellModel | undefined, b: MycliShellModel | undefined): boolean {
	return Boolean(
		a
			&& b
			&& a.provider === b.provider
			&& a.model === b.model
			&& (!a.protocol || !b.protocol || a.protocol === b.protocol),
	);
}

export class ModelSelectorComponent extends Container implements Focusable {
	private readonly searchInput = new Input();
	private readonly tui: TUI;
	private readonly currentModel?: MycliShellModel;
	private readonly models: MycliShellModel[];
	private filteredModels: MycliShellModel[];
	private selectedModelIndex = 0;
	private selectedEffortIndex = 0;
	private selectedModel?: MycliShellModel;
	private stage: SelectorStage = "model";
	private error?: string;
	private readonly onSelectCallback: (model: MycliShellModel) => void;
	private readonly onCancelCallback: () => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value && this.stage === "model";
	}

	constructor(options: ModelSelectorOptions) {
		super();
		this.tui = options.tui;
		this.currentModel = options.currentModel;
		this.models = [...options.models].sort((a, b) => {
			const aCurrent = a.current === true || modelsAreEqual(options.currentModel, a);
			const bCurrent = b.current === true || modelsAreEqual(options.currentModel, b);
			if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
			return a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);
		});
		this.filteredModels = this.models;
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;
		if (options.initialSearchInput) this.searchInput.setValue(options.initialSearchInput);
		this.searchInput.onSubmit = () => this.confirmModel();
		this.filterModels(this.searchInput.getValue());
	}

	setError(message: string): void {
		this.error = message.trim() || "Model selection failed.";
		this.tui.requestRender();
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const border = theme.fg("border", "─".repeat(safeWidth));
		const lines = [border, ""];
		if (this.stage === "reasoning") {
			lines.push(this.line(theme.bold("Select reasoning effort"), safeWidth));
			lines.push(this.line(theme.fg("muted", this.selectedModel?.model ?? ""), safeWidth));
			lines.push("");
			lines.push(...this.reasoningRows(safeWidth));
			lines.push("");
			lines.push(this.line(theme.fg("muted", "Enter select · Esc back"), safeWidth));
		} else {
			lines.push(this.line(theme.bold("Select model"), safeWidth));
			lines.push(this.line(theme.fg("muted", "Type to search · Enter select · Esc close"), safeWidth));
			lines.push("");
			lines.push(...this.searchInput.render(safeWidth).map((line) => this.line(line, safeWidth)));
			lines.push("");
			lines.push(...this.modelRows(safeWidth));
		}
		if (this.error) {
			lines.push("");
			lines.push(this.line(theme.fg("error", this.error), safeWidth));
		}
		lines.push("", border);
		return lines.map((line) => this.line(line, safeWidth));
	}

	handleInput(keyData: string): void {
		this.error = undefined;
		const kb = getKeybindings();
		if (this.stage === "reasoning") {
			const efforts = this.selectedModel?.supportedReasoningEfforts ?? [];
			if (kb.matches(keyData, "tui.select.up")) {
				this.selectedEffortIndex = this.previousIndex(this.selectedEffortIndex, efforts.length);
			} else if (kb.matches(keyData, "tui.select.down")) {
				this.selectedEffortIndex = this.nextIndex(this.selectedEffortIndex, efforts.length);
			} else if (kb.matches(keyData, "tui.select.confirm")) {
				this.confirmEffort();
			} else if (kb.matches(keyData, "tui.select.cancel")) {
				this.stage = "model";
				this.searchInput.focused = this.focused;
			}
			this.tui.requestRender();
			return;
		}
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedModelIndex = this.previousIndex(this.selectedModelIndex, this.filteredModels.length);
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedModelIndex = this.nextIndex(this.selectedModelIndex, this.filteredModels.length);
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			this.confirmModel();
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		} else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
		this.tui.requestRender();
	}

	getSearchInput(): Input {
		return this.searchInput;
	}

	private confirmModel(): void {
		const model = this.filteredModels[this.selectedModelIndex];
		if (!model) return;
		const efforts = model.supportedReasoningEfforts ?? [];
		if (efforts.length <= 1) {
			this.onSelectCallback({
				...model,
				thinkingLevel: efforts[0],
			});
			return;
		}
		this.selectedModel = model;
		const preferred = model.thinkingLevel ?? model.defaultReasoningEffort;
		const preferredIndex = preferred ? efforts.indexOf(preferred) : -1;
		this.selectedEffortIndex = preferredIndex >= 0 ? preferredIndex : 0;
		this.stage = "reasoning";
		this.searchInput.focused = false;
	}

	private confirmEffort(): void {
		const model = this.selectedModel;
		const effort = model?.supportedReasoningEfforts?.[this.selectedEffortIndex];
		if (!model || !effort) return;
		this.onSelectCallback({ ...model, thinkingLevel: effort });
	}

	private filterModels(query: string): void {
		this.filteredModels = query
			? fuzzyFilter(this.models, query, (model) => `${model.model} ${model.name ?? ""} ${model.provider}`)
			: this.models;
		this.selectedModelIndex = Math.min(this.selectedModelIndex, Math.max(0, this.filteredModels.length - 1));
	}

	private modelRows(width: number): string[] {
		if (this.filteredModels.length === 0) return [theme.fg("muted", "  No matching models")];
		const maxVisible = 10;
		const start = Math.max(0, Math.min(this.selectedModelIndex - 4, this.filteredModels.length - maxVisible));
		const end = Math.min(start + maxVisible, this.filteredModels.length);
		const showProvider = width >= 48;
		const showDescription = width >= 80;
		const rows = this.filteredModels.slice(start, end).map((model, offset) => {
			const index = start + offset;
			const selected = index === this.selectedModelIndex;
			const current = model.current === true || modelsAreEqual(this.currentModel, model);
			const markers = [current ? "current" : "", model.default ? "default" : ""].filter(Boolean).join(", ");
			const provider = showProvider ? theme.fg("muted", `  ${model.provider}`) : "";
			const marker = markers ? theme.fg("success", `  (${markers})`) : "";
			const description = showDescription && model.description ? theme.fg("dim", `  ${model.description}`) : "";
			const prefix = selected ? theme.fg("accent", "› ") : "  ";
			const name = selected ? theme.fg("accent", model.model) : model.model;
			return this.line(`${prefix}${name}${provider}${marker}${description}`, width);
		});
		if (start > 0 || end < this.filteredModels.length) {
			rows.push(this.line(theme.fg("muted", `  ${this.selectedModelIndex + 1}/${this.filteredModels.length}`), width));
		}
		return rows;
	}

	private reasoningRows(width: number): string[] {
		const model = this.selectedModel;
		const efforts = model?.supportedReasoningEfforts ?? [];
		return efforts.map((effort, index) => {
			const selected = index === this.selectedEffortIndex;
			const defaultMarker = effort === model?.defaultReasoningEffort ? theme.fg("muted", "  (default)") : "";
			const prefix = selected ? theme.fg("accent", "› ") : "  ";
			const label = selected ? theme.fg("accent", effort) : effort;
			return this.line(`${prefix}${label}${defaultMarker}`, width);
		});
	}

	private previousIndex(index: number, length: number): number {
		return length === 0 ? 0 : (index - 1 + length) % length;
	}

	private nextIndex(index: number, length: number): number {
		return length === 0 ? 0 : (index + 1) % length;
	}

	private line(text: string, width: number): string {
		return truncateToWidth(text, width, theme.fg("dim", "..."));
	}
}
