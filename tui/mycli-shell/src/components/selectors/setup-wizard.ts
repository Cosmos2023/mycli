import {
	Container,
	type Focusable,
	Input,
	Spacer,
	Text,
	TruncatedText,
	type TUI,
} from "../../tui-core/index.ts";
import { getKeybindings } from "../../tui-core/keybindings.ts";
import { FALLBACK_OPENAI_MODEL } from "../../interaction/provider-defaults.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme } from "../../theme/theme.ts";
import { DynamicBorder } from "../shared/dynamic-border.ts";
import { keyHint } from "../shared/keybinding-hints.ts";
import { ProviderList } from "./provider-list.ts";

type SetupStep = "auth" | "provider" | "api_base_url" | "model" | "api_key" | "summary";

export type SetupProvider = {
	id: string;
	name: string;
	configured?: boolean;
	default_model?: string;
	default_base_url?: string;
	protocol?: string;
};

export type SetupWizardState = {
	providers: readonly SetupProvider[];
	config_path?: string;
	auth_path?: string;
};

export type SetupWizardResult = {
	provider: string;
	api_base_url: string;
	model: string;
	api_key: string;
};

export type SetupWizardOptions = {
	tui: TUI;
	state: SetupWizardState;
	onSubmit: (result: SetupWizardResult) => void;
	onCancel: () => void;
};

export class SetupWizardComponent extends Container implements Focusable {
	private readonly searchInput = new Input();
	private readonly apiBaseUrlInput = new Input();
	private readonly modelInput = new Input();
	private readonly apiKeyInput = new Input();
	private readonly providerList: ProviderList<SetupProvider>;
	private readonly tui: TUI;
	private readonly providers: readonly SetupProvider[];
	private step: SetupStep = "auth";
	private selectedProvider: SetupProvider | null = null;
	private readonly onSubmitCallback: (result: SetupWizardResult) => void;
	private readonly onCancelCallback: () => void;
	private readonly configPath?: string;
	private readonly authPath?: string;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.updateInputFocus();
	}

	constructor(options: SetupWizardOptions) {
		super();
		this.tui = options.tui;
		this.providers = options.state.providers.length > 0 ? options.state.providers : defaultProviders();
		this.providerList = new ProviderList(this.providers, {
			emptyMessage: "No matching providers",
			detail: (provider) => {
				const model = provider.default_model ? theme.fg("muted", ` ${uiGlyphs().separator} ${provider.default_model}`) : "";
				const protocol = provider.protocol ? theme.fg("muted", ` ${uiGlyphs().separator} ${provider.protocol}`) : "";
				return model + protocol;
			},
		});
		this.configPath = options.state.config_path;
		this.authPath = options.state.auth_path;
		this.onSubmitCallback = options.onSubmit;
		this.onCancelCallback = options.onCancel;
		this.searchInput.onSubmit = () => this.selectCurrentProvider();
		this.apiBaseUrlInput.onSubmit = () => this.gotoModel();
		this.modelInput.onSubmit = () => this.gotoApiKey();
		this.apiKeyInput.onSubmit = () => this.gotoSummary();
		for (const input of [this.searchInput, this.apiBaseUrlInput, this.modelInput, this.apiKeyInput]) {
			input.onEscape = () => this.goBack();
		}
		this.rebuild();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.goBack();
			return;
		}
		if (this.step === "auth") {
			if (kb.matches(keyData, "tui.select.confirm") || keyData === "1") {
				this.step = "provider";
				this.rebuild();
			} else {
				this.tui.requestRender();
			}
			return;
		}
		if (this.step === "provider") {
			this.handleProviderInput(keyData);
			return;
		}
		if (this.step === "api_base_url") {
			this.apiBaseUrlInput.handleInput(keyData);
			this.tui.requestRender();
			return;
		}
		if (this.step === "model") {
			this.modelInput.handleInput(keyData);
			this.tui.requestRender();
			return;
		}
		if (this.step === "api_key") {
			this.apiKeyInput.handleInput(keyData);
			this.rebuild();
			return;
		}
		if (this.step === "summary" && kb.matches(keyData, "tui.select.confirm")) {
			this.submit();
		}
	}

	private handleProviderInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			this.providerList.move(-1);
			this.tui.requestRender();
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.providerList.move(1);
			this.tui.requestRender();
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			this.selectCurrentProvider();
			return;
		}
		this.searchInput.handleInput(keyData);
		this.providerList.filter(this.searchInput.getValue());
		this.tui.requestRender();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addHeader();
		if (this.step === "auth") this.renderAuth();
		else if (this.step === "provider") this.renderProvider();
		else if (this.step === "api_base_url") this.renderApiBaseUrl();
		else if (this.step === "model") this.renderModel();
		else if (this.step === "api_key") this.renderApiKey();
		else this.renderSummary();
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.updateInputFocus();
		this.tui.requestRender();
	}

	private addHeader(): void {
		this.addChild(new Text(theme.fg("accent", theme.bold("mycli setup")), 1, 0));
		this.addChild(new Text(theme.fg("muted", "Configure provider, model, credentials, and local helper tools."), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.stepText(), 1, 0));
		this.addChild(new Spacer(1));
	}

	private renderAuth(): void {
		this.addChild(new Text(theme.fg("text", "Select authentication method:"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(`${theme.fg("accent", `${uiGlyphs().arrow} 1`)}  Use an API key`, 1, 0));
		this.addChild(new Text(theme.fg("muted", "     Stored in ~/.mycli/auth.json"), 1, 0));
		this.addHint(`${keyHint("tui.select.confirm", "continue")} ${keyHint("tui.select.cancel", "cancel")}`);
	}

	private renderProvider(): void {
		this.addChild(new Text(theme.fg("text", "Select provider to configure:"), 1, 0));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.providerList);
		this.addHint(`${keyHint("tui.select.confirm", "select")} ${keyHint("tui.select.cancel", "back")}`);
	}

	private renderApiBaseUrl(): void {
		this.addChild(new Text(theme.fg("text", `Login to ${this.currentProvider().name}`), 1, 0));
		this.addChild(new Text(theme.fg("muted", "API base URL"), 1, 0));
		this.addChild(this.apiBaseUrlInput);
		this.addHint(`${keyHint("tui.select.confirm", "next")} ${keyHint("tui.select.cancel", "back")}`);
	}

	private renderModel(): void {
		this.addChild(new Text(theme.fg("text", `Default model for ${this.currentProvider().name}`), 1, 0));
		this.addChild(new Text(theme.fg("muted", "Model"), 1, 0));
		this.addChild(this.modelInput);
		this.addHint(`${keyHint("tui.select.confirm", "next")} ${keyHint("tui.select.cancel", "back")}`);
	}

	private renderApiKey(): void {
		this.addChild(new Text(theme.fg("text", `API key for ${this.currentProvider().name}`), 1, 0));
		this.addChild(new Text(`${theme.fg("muted", "> ")}${this.maskedApiKey()}${this.cursor()}`, 1, 0));
		this.addHint(`${keyHint("tui.select.confirm", "review")} ${keyHint("tui.select.cancel", "back")}`);
	}

	private renderSummary(): void {
		const provider = this.currentProvider();
		this.addChild(new Text(theme.fg("success", theme.bold("Ready to save")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${theme.fg("muted", "Provider")}  ${provider.name}`, 1, 0));
		this.addChild(new Text(`${theme.fg("muted", "Model   ")}  ${this.modelInput.getValue().trim()}`, 1, 0));
		this.addChild(new Text(`${theme.fg("muted", "API base")}  ${this.apiBaseUrlInput.getValue().trim()}`, 1, 0));
		if (this.configPath) this.addChild(new Text(`${theme.fg("muted", "Config  ")}  ${this.configPath}`, 1, 0));
		if (this.authPath) this.addChild(new Text(`${theme.fg("muted", "Secrets ")}  ${this.authPath}`, 1, 0));
		this.addHint(`${keyHint("tui.select.confirm", "save")} ${keyHint("tui.select.cancel", "back")}`);
	}

	private addHint(text: string): void {
		this.addChild(new Spacer(1));
		this.addChild(new Text(text, 1, 0));
	}

	private stepText(): string {
		const steps: SetupStep[] = ["auth", "provider", "api_base_url", "model", "api_key", "summary"];
		const index = steps.indexOf(this.step) + 1;
		const labels = {
			auth: "Auth",
			provider: "Provider",
			api_base_url: "Endpoint",
			model: "Model",
			api_key: "Secret",
			summary: "Review",
		};
		return `${theme.fg("accent", `Step ${index}/${steps.length}`)}  ${theme.fg("text", labels[this.step])}`;
	}

	private selectCurrentProvider(): void {
		const provider = this.providerList.current();
		if (!provider) return;
		this.selectedProvider = provider;
		this.apiBaseUrlInput.setValue(provider.default_base_url || "");
		this.modelInput.setValue(provider.default_model || "");
		this.step = "api_base_url";
		this.rebuild();
	}

	private gotoModel(): void {
		if (!this.apiBaseUrlInput.getValue().trim()) return;
		this.step = "model";
		this.rebuild();
	}

	private gotoApiKey(): void {
		if (!this.modelInput.getValue().trim()) return;
		this.step = "api_key";
		this.rebuild();
	}

	private gotoSummary(): void {
		if (!this.apiKeyInput.getValue().trim()) return;
		this.step = "summary";
		this.rebuild();
	}

	private goBack(): void {
		if (this.step === "auth") {
			this.onCancelCallback();
			return;
		}
		if (this.step === "provider") this.step = "auth";
		else if (this.step === "api_base_url") this.step = "provider";
		else if (this.step === "model") this.step = "api_base_url";
		else if (this.step === "api_key") this.step = "model";
		else this.step = "api_key";
		this.rebuild();
	}

	private submit(): void {
		this.onSubmitCallback({
			provider: this.currentProvider().id,
			api_base_url: this.apiBaseUrlInput.getValue().trim(),
			model: this.modelInput.getValue().trim(),
			api_key: this.apiKeyInput.getValue().trim(),
		});
	}

	private currentProvider(): SetupProvider {
		return this.selectedProvider ?? this.providerList.current() ?? this.providers[0] ?? defaultProviders()[0]!;
	}

	private maskedApiKey(): string {
		const length = this.apiKeyInput.getValue().length;
		return length > 0 ? uiGlyphs().mask.repeat(length) : theme.fg("dim", "API key");
	}

	private cursor(): string {
		return this._focused && this.step === "api_key" ? theme.fg("accent", uiGlyphs().cursor) : "";
	}

	private updateInputFocus(): void {
		this.searchInput.focused = this._focused && this.step === "provider";
		this.apiBaseUrlInput.focused = this._focused && this.step === "api_base_url";
		this.modelInput.focused = this._focused && this.step === "model";
		this.apiKeyInput.focused = this._focused && this.step === "api_key";
	}
}

function defaultProviders(): SetupProvider[] {
	return [
		{ id: "openai", name: "OpenAI", default_model: FALLBACK_OPENAI_MODEL, default_base_url: "https://api.openai.com/v1" },
		{ id: "codex", name: "Codex Responses", default_model: FALLBACK_OPENAI_MODEL, default_base_url: "https://api.openai.com/v1" },
	];
}
