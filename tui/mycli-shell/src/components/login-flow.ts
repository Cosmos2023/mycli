import {
	Container,
	type Focusable,
	fuzzyFilter,
	Input,
	Spacer,
	Text,
	TruncatedText,
	type TUI,
} from "../tui-core/index.ts";
import { getKeybindings } from "../tui-core/keybindings.ts";
import type { MycliShellAuthProvider } from "../model.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

type LoginStep = "provider" | "api_key";

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
	private readonly searchInput = new Input();
	private readonly apiKeyInput = new Input();
	private readonly listContainer = new Container();
	private readonly tui: TUI;
	private readonly providers: MycliShellAuthProvider[];
	private filteredProviders: MycliShellAuthProvider[];
	private readonly onSubmitCallback: (result: LoginFlowResult) => void;
	private readonly onCancelCallback: () => void;
	private apiKey = "";
	private step: LoginStep = "provider";
	private providerIndex = 0;
	private selectedProvider: MycliShellAuthProvider | null = null;
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
		this.filteredProviders = this.providers;
		this.onSubmitCallback = options.onSubmit;
		this.onCancelCallback = options.onCancel;
		this.searchInput.onSubmit = () => this.selectCurrentProvider();
		this.apiKeyInput.onSubmit = () => this.submitApiKey();
		this.apiKeyInput.onEscape = () => this.showProviderSelector();
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
				if (this.filteredProviders.length === 0) return;
				this.providerIndex = Math.max(0, this.providerIndex - 1);
				this.updateProviderList();
				return;
			}
			if (kb.matches(keyData, "tui.select.down")) {
				if (this.filteredProviders.length === 0) return;
				this.providerIndex = Math.min(this.filteredProviders.length - 1, this.providerIndex + 1);
				this.updateProviderList();
				return;
			}
			if (kb.matches(keyData, "tui.select.confirm")) {
				this.selectCurrentProvider();
				return;
			}
			this.searchInput.handleInput(keyData);
			this.filterProviders(this.searchInput.getValue());
			this.tui.requestRender();
			return;
		}
		this.handleApiKeyInput(keyData);
		this.tui.requestRender();
	}

	private showProviderSelector(): void {
		this.step = "provider";
		this.apiKey = "";
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
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addHint(`${keyHint("tui.select.confirm", "select")} ${keyHint("tui.select.cancel", "cancel")}`);
		this.addChild(new DynamicBorder());
		this.updateProviderList();
	}

	private updateProviderList(): void {
		this.listContainer.clear();
		const maxVisible = 8;
		const startIndex = Math.max(
			0,
			Math.min(this.providerIndex - Math.floor(maxVisible / 2), this.filteredProviders.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredProviders.length);

		for (let index = startIndex; index < endIndex; index += 1) {
			const provider = this.filteredProviders[index];
			if (!provider) continue;
			const selected = index === this.providerIndex;
			const prefix = selected ? theme.fg("accent", "→ ") : "  ";
			const name = selected ? theme.fg("accent", provider.name) : theme.fg("text", provider.name);
			this.listContainer.addChild(new TruncatedText(prefix + name + this.statusIndicator(provider), 1, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredProviders.length) {
			this.listContainer.addChild(
				new TruncatedText(theme.fg("muted", `  (${this.providerIndex + 1}/${this.filteredProviders.length})`), 1, 0),
			);
		}

		if (this.filteredProviders.length === 0) {
			const message = this.providers.length === 0 ? "No providers available" : "No matching providers";
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", `  ${message}`), 1, 0));
		}
	}

	private renderApiKeyDialog(): void {
		const provider = this.selectedProvider ?? this.filteredProviders[this.providerIndex] ?? defaultAuthProviders()[0]!;
		this.selectedProvider = provider;
		this.apiKey = this.apiKeyInput.getValue();
		this.addChild(new DynamicBorder());
		this.addHeader(`Login to ${provider.name}`);
		this.addChild(new Text(theme.fg("text", "Enter API key:"), 1, 0));
		this.addChild(new Text(`${theme.fg("muted", "> ")}${this.maskedApiKey()}${this.cursor()}`, 1, 0));
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

	private filterProviders(query: string): void {
		this.filteredProviders = query
			? fuzzyFilter(this.providers, query, (provider) => `${provider.name} ${provider.id}`)
			: this.providers;
		this.providerIndex = Math.max(0, Math.min(this.providerIndex, Math.max(0, this.filteredProviders.length - 1)));
		this.updateProviderList();
	}

	private selectCurrentProvider(): void {
		const provider = this.filteredProviders[this.providerIndex] ?? null;
		if (!provider) return;
		this.selectedProvider = provider;
		this.step = "api_key";
		this.apiKey = "";
		this.apiKeyInput.setValue("");
		this.searchInput.focused = false;
		this.apiKeyInput.focused = this._focused;
		this.rebuild();
	}

	private statusIndicator(provider: MycliShellAuthProvider): string {
		return provider.configured ? theme.fg("success", " ✓ configured") : theme.fg("muted", " • unconfigured");
	}

	private handleApiKeyInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.confirm")) {
			this.submitApiKey();
			return;
		}
		this.apiKeyInput.handleInput(keyData);
		this.apiKey = this.apiKeyInput.getValue();
		this.rebuild();
	}

	private submitApiKey(): void {
		const apiKey = this.apiKeyInput.getValue().trim();
		if (apiKey && this.selectedProvider) {
			this.onSubmitCallback({ providerId: this.selectedProvider.id, apiKey });
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
