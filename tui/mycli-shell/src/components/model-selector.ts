import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	truncateToWidth,
	type TUI,
} from "../tui-core/index.ts";
import type { ModelSelectionScope } from "@mycli/contracts";
import type { MycliShellModel, MycliShellProviderRoute } from "../model.ts";
import { safeErrorMessage } from "../safe-ui-text.ts";
import { uiGlyphs } from "../theme/terminal-style.ts";
import { theme } from "../theme/theme.ts";
import { keyForAction, keyHint, rawKeyHint } from "./keybinding-hints.ts";

type SelectorStage =
	| "provider_loading"
	| "provider"
	| "provider_error"
	| "model_loading"
	| "model_empty"
	| "model_error"
	| "model"
	| "reasoning"
	| "scope";

const SCOPE_OPTIONS: readonly {
	readonly scope: ModelSelectionScope;
	readonly label: string;
	readonly description: string;
}[] = Object.freeze([
	{
		scope: "session",
		label: "Use for this session",
		description: "Restored when this session resumes",
	},
	{
		scope: "user",
		label: "Make user default",
		description: "Also used by new sessions",
	},
]);

export type ModelSelectorOptions = {
	tui: TUI;
	currentModel?: MycliShellModel;
	models: MycliShellModel[];
	preferredProviderId?: string;
	lockPreferredProvider?: boolean;
	onProviderLoad?: () => Promise<MycliShellProviderRoute[]>;
	onModelLoad?: (providerId: string) => Promise<MycliShellModel[]>;
	onProvidersLoaded?: (providers: MycliShellProviderRoute[]) => void;
	onModelsLoaded?: (providerId: string, models: MycliShellModel[]) => void;
	onLoginRequired?: (provider: MycliShellProviderRoute) => void;
	onSelect: (model: MycliShellModel, scope: ModelSelectionScope) => void;
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
	private models: MycliShellModel[];
	private filteredModels: MycliShellModel[];
	private providers: MycliShellProviderRoute[] = [];
	private filteredProviders: MycliShellProviderRoute[] = [];
	private selectedProviderIndex = 0;
	private selectedProvider?: MycliShellProviderRoute;
	private selectedModelIndex = 0;
	private selectedEffortIndex = 0;
	private selectedScopeIndex = 0;
	private selectedModel?: MycliShellModel;
	private stage: SelectorStage = "model";
	private error?: string;
	private loadError?: string;
	private submitting = false;
	private loadGeneration = 0;
	private readonly initialSearchInput: string;
	private readonly preferredProviderId?: string;
	private readonly lockPreferredProvider: boolean;
	private readonly onProviderLoad?: () => Promise<MycliShellProviderRoute[]>;
	private readonly onModelLoad?: (providerId: string) => Promise<MycliShellModel[]>;
	private readonly onProvidersLoaded?: (providers: MycliShellProviderRoute[]) => void;
	private readonly onModelsLoaded?: (providerId: string, models: MycliShellModel[]) => void;
	private readonly onLoginRequired?: (provider: MycliShellProviderRoute) => void;
	private readonly onSelectCallback: (model: MycliShellModel, scope: ModelSelectionScope) => void;
	private readonly onCancelCallback: () => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value && (this.stage === "model" || this.stage === "provider");
	}

	constructor(options: ModelSelectorOptions) {
		super();
		this.tui = options.tui;
		this.currentModel = options.currentModel;
		this.models = this.sortedModels(options.models);
		this.filteredModels = this.models;
		this.initialSearchInput = options.initialSearchInput ?? "";
		this.preferredProviderId = options.preferredProviderId;
		this.lockPreferredProvider = options.lockPreferredProvider === true;
		this.onProviderLoad = options.onProviderLoad;
		this.onModelLoad = options.onModelLoad;
		this.onProvidersLoaded = options.onProvidersLoaded;
		this.onModelsLoaded = options.onModelsLoaded;
		this.onLoginRequired = options.onLoginRequired;
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;
		this.searchInput.onSubmit = () => this.confirmCurrentStage();
		if (this.onProviderLoad) {
			this.stage = "provider_loading";
			queueMicrotask(() => { void this.loadProviders(); });
		} else {
			if (this.initialSearchInput) this.searchInput.setValue(this.initialSearchInput);
			this.filterModels(this.searchInput.getValue());
		}
	}

	setError(message: string): void {
		this.submitting = false;
		this.error = message.trim() || "Model selection failed.";
		this.tui.requestRender();
	}

	override render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const border = theme.fg("border", uiGlyphs().horizontal.repeat(safeWidth));
		const lines = [border, ""];
		if (this.stage === "provider_loading") {
			lines.push(this.line(theme.bold("Select provider"), safeWidth));
			lines.push("");
			lines.push(this.line(theme.fg("muted", "  Loading providers..."), safeWidth));
			lines.push("");
			lines.push(this.line(theme.fg("muted", "Esc close"), safeWidth));
		} else if (this.stage === "provider_error") {
			lines.push(this.line(theme.bold("Select provider"), safeWidth));
			lines.push("");
			lines.push(this.line(theme.fg("error", this.loadError ?? "Provider routes could not be loaded."), safeWidth));
			lines.push("");
			lines.push(this.line(theme.fg("muted", `Enter retry ${uiGlyphs().separator} Esc close`), safeWidth));
		} else if (this.stage === "provider") {
			lines.push(this.line(theme.bold("Select provider"), safeWidth));
			lines.push(this.line(theme.fg("muted", `Type to search ${uiGlyphs().separator} Enter select ${uiGlyphs().separator} Esc close`), safeWidth));
			lines.push("");
			lines.push(...this.searchInput.render(safeWidth).map((line) => this.line(line, safeWidth)));
			lines.push("");
			lines.push(...this.providerRows(safeWidth));
		} else if (this.stage === "model_loading") {
			lines.push(this.line(theme.bold("Select model"), safeWidth));
			lines.push(this.line(theme.fg("muted", this.selectedProvider?.name ?? ""), safeWidth));
			lines.push("");
			lines.push(this.line(theme.fg("muted", "  Loading models..."), safeWidth));
			lines.push("");
			lines.push(this.line(theme.fg("muted", this.modelBackHint()), safeWidth));
		} else if (this.stage === "model_empty" || this.stage === "model_error") {
			lines.push(this.line(theme.bold("Select model"), safeWidth));
			lines.push(this.line(theme.fg("muted", this.selectedProvider?.name ?? ""), safeWidth));
			lines.push("");
			lines.push(this.line(
				this.stage === "model_error"
					? theme.fg("error", this.loadError ?? "Models could not be loaded.")
					: theme.fg("muted", "  No models are available for this provider."),
				safeWidth,
			));
			lines.push("");
			lines.push(this.line(theme.fg("muted", `Enter retry ${uiGlyphs().separator} ${this.modelBackHint()}`), safeWidth));
		} else if (this.stage === "scope") {
			lines.push(this.line(theme.bold("Choose where to apply"), safeWidth));
			lines.push(this.line(theme.fg("muted", this.selectedModel?.model ?? ""), safeWidth));
			lines.push("");
			lines.push(...this.scopeRows(safeWidth));
			lines.push("");
			lines.push(this.line(theme.fg("muted", `Enter select ${uiGlyphs().separator} Esc back`), safeWidth));
		} else if (this.stage === "reasoning") {
			lines.push(this.line(theme.bold("Select reasoning effort"), safeWidth));
			lines.push(this.line(theme.fg("muted", this.selectedModel?.model ?? ""), safeWidth));
			lines.push("");
			lines.push(...this.reasoningRows(safeWidth));
			lines.push("");
			lines.push(this.line(theme.fg("muted", `Enter select ${uiGlyphs().separator} Esc back`), safeWidth));
		} else {
			lines.push(this.line(theme.bold("Select model"), safeWidth));
			lines.push(this.line(theme.fg("muted", this.selectedProvider?.name ?? ""), safeWidth));
			lines.push(this.line(theme.fg("muted", [
				"Type to search",
				keyHint("tui.select.confirm", "use"),
				keyHint("tui.select.options", "options"),
				...(this.providerCycleHint() ? [this.providerCycleHint()] : []),
				this.modelBackHint(),
			].join(` ${uiGlyphs().separator} `)), safeWidth));
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
		if (this.submitting) return;
		this.error = undefined;
		const kb = getKeybindings();
		if (this.stage === "provider_loading") {
			if (kb.matches(keyData, "tui.select.cancel")) this.cancel();
			this.tui.requestRender();
			return;
		}
		if (this.stage === "model_loading") {
			if (kb.matches(keyData, "tui.select.previousGroup")) this.cycleProvider(-1);
			else if (kb.matches(keyData, "tui.select.nextGroup")) this.cycleProvider(1);
			else if (kb.matches(keyData, "tui.select.cancel")) this.backFromModels();
			this.tui.requestRender();
			return;
		}
		if (this.stage === "provider_error") {
			if (kb.matches(keyData, "tui.select.confirm")) void this.loadProviders();
			else if (kb.matches(keyData, "tui.select.cancel")) this.cancel();
			this.tui.requestRender();
			return;
		}
		if (this.stage === "model_error" || this.stage === "model_empty") {
			if (kb.matches(keyData, "tui.select.previousGroup")) {
				this.cycleProvider(-1);
			} else if (kb.matches(keyData, "tui.select.nextGroup")) {
				this.cycleProvider(1);
			} else if (kb.matches(keyData, "tui.select.confirm") && this.selectedProvider) {
				void this.loadModels(this.selectedProvider);
			} else if (kb.matches(keyData, "tui.select.cancel")) {
				this.backFromModels();
			}
			this.tui.requestRender();
			return;
		}
		if (this.stage === "provider") {
			if (kb.matches(keyData, "tui.select.up")) {
				this.selectedProviderIndex = this.previousIndex(this.selectedProviderIndex, this.filteredProviders.length);
			} else if (kb.matches(keyData, "tui.select.down")) {
				this.selectedProviderIndex = this.nextIndex(this.selectedProviderIndex, this.filteredProviders.length);
			} else if (kb.matches(keyData, "tui.select.confirm")) {
				this.confirmProvider();
			} else if (kb.matches(keyData, "tui.select.cancel")) {
				this.cancel();
			} else {
				this.searchInput.handleInput(keyData);
				this.filterProviders(this.searchInput.getValue());
			}
			this.tui.requestRender();
			return;
		}
		if (this.stage === "scope") {
			if (kb.matches(keyData, "tui.select.up")) {
				this.selectedScopeIndex = this.previousIndex(this.selectedScopeIndex, SCOPE_OPTIONS.length);
			} else if (kb.matches(keyData, "tui.select.down")) {
				this.selectedScopeIndex = this.nextIndex(this.selectedScopeIndex, SCOPE_OPTIONS.length);
			} else if (kb.matches(keyData, "tui.select.confirm")) {
				this.confirmScope();
			} else if (kb.matches(keyData, "tui.select.cancel")) {
				this.backFromScope();
			}
			this.tui.requestRender();
			return;
		}
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
		} else if (kb.matches(keyData, "tui.select.previousGroup")) {
			this.cycleProvider(-1);
		} else if (kb.matches(keyData, "tui.select.nextGroup")) {
			this.cycleProvider(1);
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			this.quickSelectModel();
		} else if (kb.matches(keyData, "tui.select.options")) {
			this.confirmModel();
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.backFromModels();
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
			this.openScope({
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

	private quickSelectModel(): void {
		const model = this.filteredModels[this.selectedModelIndex];
		if (!model) return;
		const efforts = model.supportedReasoningEfforts ?? [];
		const preferred = model.defaultReasoningEffort;
		const effort = preferred && efforts.includes(preferred) ? preferred : efforts[0];
		this.selectedModel = { ...model, thinkingLevel: effort };
		this.submitting = true;
		this.onSelectCallback(this.selectedModel, "session");
	}

	private confirmCurrentStage(): void {
		if (this.stage === "provider") this.confirmProvider();
		else if (this.stage === "model") this.quickSelectModel();
	}

	private confirmProvider(): void {
		const provider = this.filteredProviders[this.selectedProviderIndex];
		if (!provider) return;
		if (!provider.ready && this.onLoginRequired) {
			this.loadGeneration += 1;
			this.onLoginRequired(provider);
			return;
		}
		void this.loadModels(provider);
	}

	private confirmEffort(): void {
		const model = this.selectedModel;
		const effort = model?.supportedReasoningEfforts?.[this.selectedEffortIndex];
		if (!model || !effort) return;
		this.openScope({ ...model, thinkingLevel: effort });
	}

	private openScope(model: MycliShellModel): void {
		this.selectedModel = model;
		this.selectedScopeIndex = 0;
		this.stage = "scope";
		this.searchInput.focused = false;
	}

	private confirmScope(): void {
		const model = this.selectedModel;
		const option = SCOPE_OPTIONS[this.selectedScopeIndex];
		if (!model || !option) return;
		this.submitting = true;
		this.onSelectCallback(model, option.scope);
	}

	private backFromScope(): void {
		const efforts = this.selectedModel?.supportedReasoningEfforts ?? [];
		this.stage = efforts.length > 1 ? "reasoning" : "model";
		this.searchInput.focused = this.focused && this.stage === "model";
	}

	private filterModels(query: string): void {
		this.filteredModels = query
			? fuzzyFilter(this.models, query, (model) => `${model.model} ${model.name ?? ""} ${model.provider}`)
			: this.models;
		this.selectedModelIndex = Math.min(this.selectedModelIndex, Math.max(0, this.filteredModels.length - 1));
	}

	private filterProviders(query: string): void {
		this.filteredProviders = query
			? fuzzyFilter(this.providers, query, (provider) => `${provider.name} ${provider.id}`)
			: this.providers;
		this.selectedProviderIndex = Math.min(
			this.selectedProviderIndex,
			Math.max(0, this.filteredProviders.length - 1),
		);
	}

	private async loadProviders(): Promise<void> {
		const generation = ++this.loadGeneration;
		this.stage = "provider_loading";
		this.loadError = undefined;
		this.searchInput.setValue("");
		this.tui.requestRender();
		try {
			const loaded = this.onProviderLoad ? await this.onProviderLoad() : [];
			if (generation !== this.loadGeneration) return;
			this.providers = loaded
				.filter((provider) => provider.configured && provider.activation === "active")
				.sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
			this.filteredProviders = this.providers;
			this.onProvidersLoaded?.([...loaded]);
			if (this.providers.length === 0) {
				this.loadError = "No activated provider routes are available.";
				this.stage = "provider_error";
				return;
			}
			const preferred = (this.preferredProviderId
				? this.providers.find((provider) => provider.id === this.preferredProviderId)
				: undefined) ?? this.providers.find((provider) => provider.current);
			if (preferred) this.selectedProviderIndex = this.providers.indexOf(preferred);
			if (this.providers.length === 1 || preferred) {
				const provider = preferred ?? this.providers[0]!;
				if (!provider.ready && this.onLoginRequired) {
					this.onLoginRequired(provider);
					return;
				}
				await this.loadModels(provider);
				return;
			}
			this.stage = "provider";
			this.searchInput.focused = this.focused;
		} catch (error) {
			if (generation !== this.loadGeneration) return;
			this.loadError = this.safeLoadError(error, "Provider routes could not be loaded.");
			this.stage = "provider_error";
		} finally {
			this.tui.requestRender();
		}
	}

	private async loadModels(provider: MycliShellProviderRoute): Promise<void> {
		if (!this.onModelLoad) return;
		const generation = ++this.loadGeneration;
		this.selectedProvider = provider;
		this.stage = "model_loading";
		this.loadError = undefined;
		this.searchInput.setValue("");
		this.searchInput.focused = false;
		this.tui.requestRender();
		try {
			const loaded = await this.onModelLoad(provider.id);
			if (generation !== this.loadGeneration || this.selectedProvider?.id !== provider.id) return;
			this.models = this.sortedModels(loaded.filter((model) => model.provider === provider.id));
			this.filteredModels = this.models;
			this.onModelsLoaded?.(provider.id, [...this.models]);
			if (this.models.length === 0) {
				this.stage = "model_empty";
				return;
			}
			if (this.initialSearchInput) this.searchInput.setValue(this.initialSearchInput);
			this.filterModels(this.searchInput.getValue());
			this.stage = "model";
			this.searchInput.focused = this.focused;
		} catch (error) {
			if (generation !== this.loadGeneration || this.selectedProvider?.id !== provider.id) return;
			this.loadError = this.safeLoadError(error, "Models could not be loaded.");
			this.stage = "model_error";
		} finally {
			this.tui.requestRender();
		}
	}

	private sortedModels(models: MycliShellModel[]): MycliShellModel[] {
		return [...models].sort((a, b) => {
			const aCurrent = a.current === true || modelsAreEqual(this.currentModel, a);
			const bCurrent = b.current === true || modelsAreEqual(this.currentModel, b);
			if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
			return a.model.localeCompare(b.model);
		});
	}

	private backFromModels(): void {
		this.loadGeneration += 1;
		if (this.providers.length > 1 && !this.lockPreferredProvider) {
			this.stage = "provider";
			this.loadError = undefined;
			this.searchInput.setValue("");
			this.filterProviders("");
			this.searchInput.focused = this.focused;
			return;
		}
		this.cancel();
	}

	private cancel(): void {
		this.loadGeneration += 1;
		this.onCancelCallback();
	}

	private modelBackHint(): string {
		return keyHint(
			"tui.select.cancel",
			this.providers.length > 1 && !this.lockPreferredProvider ? "providers" : "close",
		);
	}

	private providerCycleHint(): string {
		if (this.providers.length <= 1 || this.lockPreferredProvider) return "";
		return rawKeyHint(
			`${keyForAction("tui.select.previousGroup")}/${keyForAction("tui.select.nextGroup")}`,
			"provider",
		);
	}

	private cycleProvider(offset: -1 | 1): void {
		if (this.providers.length <= 1 || this.lockPreferredProvider) return;
		const currentIndex = this.selectedProvider
			? this.providers.findIndex((provider) => provider.id === this.selectedProvider?.id)
			: this.selectedProviderIndex;
		const nextIndex = (Math.max(0, currentIndex) + offset + this.providers.length)
			% this.providers.length;
		const provider = this.providers[nextIndex];
		if (!provider) return;
		this.selectedProviderIndex = nextIndex;
		if (!provider.ready && this.onLoginRequired) {
			this.loadGeneration += 1;
			this.onLoginRequired(provider);
			return;
		}
		void this.loadModels(provider);
	}

	private safeLoadError(error: unknown, fallback: string): string {
		return safeErrorMessage(error, fallback).slice(0, 240);
	}

	private providerRows(width: number): string[] {
		if (this.filteredProviders.length === 0) return [theme.fg("muted", "  No matching providers")];
		const maxVisible = 10;
		const start = Math.max(0, Math.min(this.selectedProviderIndex - 4, this.filteredProviders.length - maxVisible));
		const end = Math.min(start + maxVisible, this.filteredProviders.length);
		const rows = this.filteredProviders.slice(start, end).map((provider, offset) => {
			const index = start + offset;
			const selected = index === this.selectedProviderIndex;
			const prefix = selected ? theme.fg("accent", `${uiGlyphs().selector} `) : "  ";
			const label = selected ? theme.fg("accent", provider.name) : provider.name;
			const route = width >= 48 && provider.name !== provider.id
				? theme.fg("muted", `  ${provider.id}`)
				: "";
			const status = provider.ready
				? theme.fg("success", "  ready")
				: theme.fg("warning", "  login required");
			return this.line(`${prefix}${label}${route}${status}`, width);
		});
		if (start > 0 || end < this.filteredProviders.length) {
			rows.push(this.line(theme.fg("muted", `  ${this.selectedProviderIndex + 1}/${this.filteredProviders.length}`), width));
		}
		return rows;
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
			const prefix = selected ? theme.fg("accent", `${uiGlyphs().selector} `) : "  ";
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
			const prefix = selected ? theme.fg("accent", `${uiGlyphs().selector} `) : "  ";
			const label = selected ? theme.fg("accent", effort) : effort;
			return this.line(`${prefix}${label}${defaultMarker}`, width);
		});
	}

	private scopeRows(width: number): string[] {
		return SCOPE_OPTIONS.map((option, index) => {
			const selected = index === this.selectedScopeIndex;
			const prefix = selected ? theme.fg("accent", `${uiGlyphs().selector} `) : "  ";
			const label = selected ? theme.fg("accent", option.label) : option.label;
			const description = theme.fg("muted", `  ${option.description}`);
			return this.line(`${prefix}${label}${description}`, width);
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
