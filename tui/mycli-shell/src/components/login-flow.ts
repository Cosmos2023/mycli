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
import { ProviderList } from "./provider-list.ts";

type LoginStep = "provider" | "api_key";

export type LoginFlowResult = {
	providerId: string;
	authRef: string;
	apiKey: string;
};

export type LoginFlowOptions = {
	tui: TUI;
	providers: MycliShellAuthProvider[];
	initialProviderId?: string;
	initialAuthRef?: string;
	onSubmit: (result: LoginFlowResult) => void;
	onCancel: () => void;
};

export class LoginFlowComponent extends Container implements Focusable {
	private readonly searchInput = new Input();
	private readonly apiKeyInput = new Input();
	private readonly providerList: ProviderList<MycliShellAuthProvider>;
	private readonly tui: TUI;
	private readonly providers: MycliShellAuthProvider[];
	private readonly onSubmitCallback: (result: LoginFlowResult) => void;
	private readonly onCancelCallback: () => void;
	private apiKey = "";
	private step: LoginStep = "provider";
	private selectedProvider: MycliShellAuthProvider | null = null;
	private selectedAuthRef = "";
	private errorMessage = "";
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value && this.step === "provider";
		this.apiKeyInput.focused = value && this.step === "api_key";
	}

	constructor(options: LoginFlowOptions) {
		super();
		this.tui = options.tui;
		this.providers = options.providers.length > 0 ? options.providers : defaultAuthProviders();
		this.providerList = new ProviderList(this.providers, {
			emptyMessage: "No matching providers",
			showPosition: true,
		});
		this.onSubmitCallback = options.onSubmit;
		this.onCancelCallback = options.onCancel;
		const initialProvider = options.initialProviderId
			? this.providers.find((provider) => provider.id === options.initialProviderId) ?? null
			: null;
		if (initialProvider) {
			this.selectedProvider = initialProvider;
			this.selectedAuthRef = options.initialAuthRef?.trim()
				|| initialProvider.authRef
				|| initialProvider.id;
			this.step = "api_key";
		}
		this.searchInput.onSubmit = () => this.selectCurrentProvider();
		this.apiKeyInput.onSubmit = () => this.submitApiKey();
		this.apiKeyInput.onEscape = () => this.showProviderSelector();
		this.rebuild();
	}

	setError(message: string): void {
		this.errorMessage = message.trim() || "Failed to save API key.";
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
		if (this.step === "provider") {
			if (kb.matches(keyData, "tui.select.up")) {
				this.providerList.move(-1);
				return;
			}
			if (kb.matches(keyData, "tui.select.down")) {
				this.providerList.move(1);
				return;
			}
			if (kb.matches(keyData, "tui.select.confirm")) {
				this.selectCurrentProvider();
				return;
			}
			this.searchInput.handleInput(keyData);
			this.providerList.filter(this.searchInput.getValue());
			this.tui.requestRender();
			return;
		}
		this.handleApiKeyInput(keyData);
		this.tui.requestRender();
	}

	private showProviderSelector(): void {
		this.step = "provider";
		this.apiKey = "";
		this.errorMessage = "";
		this.searchInput.focused = this._focused;
		this.apiKeyInput.focused = false;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		if (this.step === "provider") {
			this.renderProviderSelector();
		} else {
			this.renderApiKeyDialog();
		}
		this.tui.requestRender();
	}

	private renderProviderSelector(): void {
		this.addChild(new DynamicBorder());
		this.addHeader("Select provider to configure:");
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.providerList);
		this.addChild(new Spacer(1));
		this.addHint(`${keyHint("tui.select.confirm", "select")} ${keyHint("tui.select.cancel", "cancel")}`);
		this.addChild(new DynamicBorder());
	}

	private renderApiKeyDialog(): void {
		const provider = this.selectedProvider ?? this.providerList.current() ?? defaultAuthProviders()[0]!;
		this.selectedProvider = provider;
		this.selectedAuthRef ||= provider.authRef ?? provider.id;
		this.apiKey = this.apiKeyInput.getValue();
		this.addChild(new DynamicBorder());
		this.addHeader(`Login to ${provider.name}`);
		this.addChild(new Text(theme.fg("text", "Enter API key:"), 1, 0));
		this.addChild(new Text(`${theme.fg("muted", "> ")}${this.maskedApiKey()}${this.cursor()}`, 1, 0));
		if (this.errorMessage) {
			this.addChild(new Text(theme.fg("error", this.errorMessage), 1, 0));
		}
		this.addHint(`${keyHint("tui.select.cancel", "back,")} ${keyHint("tui.select.confirm", "save")}`);
		this.addChild(new DynamicBorder());
	}

	private addHeader(title: string): void {
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	}

	private addHint(text: string): void {
		this.addChild(new Text(text, 1, 0));
		this.addChild(new Spacer(1));
	}

	private selectCurrentProvider(): void {
		const provider = this.providerList.current() ?? null;
		if (!provider) return;
		this.selectedProvider = provider;
		this.selectedAuthRef = provider.authRef ?? provider.id;
		this.step = "api_key";
		this.apiKey = "";
		this.apiKeyInput.setValue("");
		this.searchInput.focused = false;
		this.apiKeyInput.focused = this._focused;
		this.rebuild();
	}

	private handleApiKeyInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.confirm")) {
			this.submitApiKey();
			return;
		}
		this.errorMessage = "";
		this.apiKeyInput.handleInput(keyData);
		this.apiKey = this.apiKeyInput.getValue();
		this.rebuild();
	}

	private submitApiKey(): void {
		const apiKey = this.apiKeyInput.getValue().trim();
		if (apiKey && this.selectedProvider) {
			this.onSubmitCallback({
				providerId: this.selectedProvider.id,
				authRef: this.selectedAuthRef || this.selectedProvider.id,
				apiKey,
			});
		}
	}

	private maskedApiKey(): string {
		return this.apiKey.length > 0 ? "•".repeat(this.apiKey.length) : theme.fg("dim", "API key");
	}

	private cursor(): string {
		return this._focused ? theme.fg("accent", "▌") : "";
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
