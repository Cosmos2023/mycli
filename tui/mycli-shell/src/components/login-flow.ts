import {
	Container,
	type Focusable,
	Input,
	Spacer,
	Text,
	type TUI,
} from "../tui-core/index.ts";
import { getKeybindings } from "../tui-core/keybindings.ts";
import type { MycliShellAuthProvider } from "../model.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

type LoginStep = "auth" | "provider" | "api_key";

export type LoginFlowResult = {
	providerId: string;
	apiKey: string;
};

export type LoginFlowOptions = {
	tui: TUI;
	providers: MycliShellAuthProvider[];
	onSubmit: (result: LoginFlowResult) => void;
	onCancel: () => void;
};

export class LoginFlowComponent extends Container implements Focusable {
	private readonly tui: TUI;
	private readonly providers: MycliShellAuthProvider[];
	private readonly onSubmitCallback: (result: LoginFlowResult) => void;
	private readonly onCancelCallback: () => void;
	private readonly apiKeyInput = new Input();
	private step: LoginStep = "auth";
	private providerIndex = 0;
	private selectedProvider: MycliShellAuthProvider | null = null;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.apiKeyInput.focused = value && this.step === "api_key";
	}

	constructor(options: LoginFlowOptions) {
		super();
		this.tui = options.tui;
		this.providers = options.providers.length > 0 ? options.providers : defaultAuthProviders();
		this.onSubmitCallback = options.onSubmit;
		this.onCancelCallback = options.onCancel;
		this.apiKeyInput.onSubmit = (value) => {
			const apiKey = value.trim();
			if (!apiKey || !this.selectedProvider) {
				return;
			}
			this.onSubmitCallback({ providerId: this.selectedProvider.id, apiKey });
		};
		this.apiKeyInput.onEscape = () => this.onCancelCallback();
		this.rebuild();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.step === "api_key") {
				this.showProviderSelector();
			} else {
				this.onCancelCallback();
			}
			return;
		}
		if (this.step === "auth") {
			if (kb.matches(keyData, "tui.select.confirm") || keyData === "1") {
				this.showProviderSelector();
			}
			return;
		}
		if (this.step === "provider") {
			if (kb.matches(keyData, "tui.select.up")) {
				this.providerIndex = this.providerIndex === 0 ? this.providers.length - 1 : this.providerIndex - 1;
				this.rebuild();
				return;
			}
			if (kb.matches(keyData, "tui.select.down")) {
				this.providerIndex = this.providerIndex === this.providers.length - 1 ? 0 : this.providerIndex + 1;
				this.rebuild();
				return;
			}
			if (kb.matches(keyData, "tui.select.confirm")) {
				this.selectedProvider = this.providers[this.providerIndex] ?? null;
				this.step = "api_key";
				this.apiKeyInput.setValue("");
				this.rebuild();
				return;
			}
			return;
		}
		this.apiKeyInput.handleInput(keyData);
		this.tui.requestRender();
	}

	private showProviderSelector(): void {
		this.step = "provider";
		this.apiKeyInput.focused = false;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
		if (this.step === "auth") {
			this.renderAuthTypeSelector();
		} else if (this.step === "provider") {
			this.renderProviderSelector();
		} else {
			this.renderApiKeyDialog();
		}
		this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
		this.tui.requestRender();
	}

	private renderAuthTypeSelector(): void {
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Select authentication method:")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${theme.fg("accent", "→ ")}${theme.fg("accent", "Use an API key")}`, 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${keyHint("tui.select.confirm", "select")} ${keyHint("tui.select.cancel", "cancel")}`, 1, 0));
		this.addChild(new Spacer(1));
	}

	private renderProviderSelector(): void {
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Select provider to configure:")), 1, 0));
		this.addChild(new Spacer(1));
		for (let index = 0; index < this.providers.length; index += 1) {
			const provider = this.providers[index];
			if (!provider) continue;
			const selected = index === this.providerIndex;
			const prefix = selected ? theme.fg("accent", "→ ") : "  ";
			const name = selected ? theme.fg("accent", provider.name) : theme.fg("text", provider.name);
			const status = provider.configured
				? theme.fg("success", " ✓ configured")
				: theme.fg("muted", " • unconfigured");
			const model = provider.defaultModel ? theme.fg("muted", ` · default model ${provider.defaultModel}`) : "";
			this.addChild(new Text(prefix + name + status + model, 1, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${keyHint("tui.select.confirm", "select")} ${keyHint("tui.select.cancel", "back")}`, 1, 0));
		this.addChild(new Spacer(1));
	}

	private renderApiKeyDialog(): void {
		const provider = this.selectedProvider ?? this.providers[this.providerIndex] ?? defaultAuthProviders()[0]!;
		this.selectedProvider = provider;
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(`Login to ${provider.name}`)), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("text", "Enter API key:"), 1, 0));
		this.apiKeyInput.focused = this._focused;
		this.addChild(this.apiKeyInput);
		this.addChild(new Text(`${keyHint("tui.select.cancel", "back,")} ${keyHint("tui.select.confirm", "save")}`, 1, 0));
		this.addChild(new Spacer(1));
	}
}

function defaultAuthProviders(): MycliShellAuthProvider[] {
	return [
		{ id: "openai", name: "OpenAI", defaultModel: "gpt-5" },
		{ id: "deepseek", name: "DeepSeek", defaultModel: "deepseek-v4-flash" },
		{ id: "qwen", name: "Qwen", defaultModel: "qwen-plus" },
		{ id: "anthropic", name: "Anthropic", defaultModel: "claude-sonnet-4-5" },
		{ id: "compatible", name: "Compatible" },
	];
}
