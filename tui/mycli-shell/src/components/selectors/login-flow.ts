import {
	Container,
	type Focusable,
	Input,
	Spacer,
	Text,
	type TUI,
} from "../../tui-core/index.ts";
import { getKeybindings } from "../../tui-core/keybindings.ts";
import type { MycliShellAuthProvider } from "../../model.ts";
import { uiGlyphs } from "../../theme/terminal-style.ts";
import { theme } from "../../theme/theme.ts";
import { DynamicBorder } from "../shared/dynamic-border.ts";
import { keyHint } from "../shared/keybinding-hints.ts";
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
	onBack?: () => void;
};

export class LoginFlowComponent extends Container implements Focusable {
	private readonly searchInput = new Input();
	private readonly apiKeyInput = new Input();
	private readonly providerList: ProviderList<MycliShellAuthProvider>;
	private readonly tui: TUI;
	private readonly providers: MycliShellAuthProvider[];
	private readonly onSubmitCallback: (result: LoginFlowResult) => void;
	private readonly onCancelCallback: () => void;
	private readonly onBackCallback?: () => void;
	private apiKey = "";
	private step: LoginStep = "provider";
	private selectedProvider: MycliShellAuthProvider | null = null;
	private selectedAuthRef = "";
	private errorMessage = "";
	private submitting = false;
	private submissionGeneration = 0;
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
		const initialAuthRef = options.initialAuthRef?.trim();
		this.providers = (options.providers.length > 0 ? options.providers : defaultAuthProviders())
			.map((provider) => provider.id === options.initialProviderId && initialAuthRef
				&& initialAuthRef !== (provider.authRef ?? provider.id)
				? { ...provider, authRef: initialAuthRef, configured: undefined, credentialSource: undefined }
				: provider);
		this.providerList = new ProviderList(this.providers, {
			emptyMessage: "No matching providers",
			showPosition: true,
		});
		this.onSubmitCallback = options.onSubmit;
		this.onCancelCallback = options.onCancel;
		this.onBackCallback = options.onBack;
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
		this.apiKeyInput.onEscape = () => this.backFromApiKey();
		this.rebuild();
	}

	setError(message: string): void {
		this.submitting = false;
		this.errorMessage = message.trim() || "Failed to save API key.";
		this.rebuild();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.submissionGeneration += 1;
			this.submitting = false;
			if (this.step === "api_key") {
				this.backFromApiKey();
			} else {
				this.onCancelCallback();
			}
			return;
		}
		if (this.submitting) return;
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

	private backFromApiKey(): void {
		this.apiKey = "";
		this.apiKeyInput.setValue("");
		this.errorMessage = "";
		if (this.onBackCallback) {
			this.onBackCallback();
			return;
		}
		this.step = "provider";
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
		this.addHint(this.submitting
			? `Saving API key... ${keyHint("tui.select.cancel", "back")}`
			: `${keyHint("tui.select.cancel", "back,")} ${keyHint("tui.select.confirm", "save")}`);
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
		if (this.submitting) return;
		const apiKey = this.apiKeyInput.getValue().trim();
		if (apiKey && this.selectedProvider) {
			this.submitting = true;
			this.submissionGeneration += 1;
			this.rebuild();
			this.onSubmitCallback({
				providerId: this.selectedProvider.id,
				authRef: this.selectedAuthRef || this.selectedProvider.id,
				apiKey,
			});
		}
	}

	getSubmissionGeneration(): number {
		return this.submissionGeneration;
	}

	private maskedApiKey(): string {
		return this.apiKey.length > 0 ? uiGlyphs().mask.repeat(this.apiKey.length) : theme.fg("dim", "API key");
	}

	private cursor(): string {
		return this._focused ? theme.fg("accent", uiGlyphs().cursor) : "";
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
