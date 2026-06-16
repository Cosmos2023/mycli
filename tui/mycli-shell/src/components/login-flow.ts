import {
	Container,
	type Focusable,
	Spacer,
	Text,
	type TUI,
} from "../tui-core/index.ts";
import { getKeybindings } from "../tui-core/keybindings.ts";
import type { MycliShellAuthProvider } from "../model.ts";
import { theme } from "../theme/theme.ts";
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
	private apiKey = "";
	private step: LoginStep = "auth";
	private providerIndex = 0;
	private selectedProvider: MycliShellAuthProvider | null = null;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	constructor(options: LoginFlowOptions) {
		super();
		this.tui = options.tui;
		this.providers = options.providers.length > 0 ? options.providers : defaultAuthProviders();
		this.onSubmitCallback = options.onSubmit;
		this.onCancelCallback = options.onCancel;
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
				this.apiKey = "";
				this.rebuild();
				return;
			}
			return;
		}
		this.handleApiKeyInput(keyData);
		this.tui.requestRender();
	}

	private showProviderSelector(): void {
		this.step = "provider";
		this.apiKey = "";
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		if (this.step === "auth") {
			this.renderAuthTypeSelector();
		} else if (this.step === "provider") {
			this.renderProviderSelector();
		} else {
			this.renderApiKeyDialog();
		}
		this.tui.requestRender();
	}

	private renderAuthTypeSelector(): void {
		this.addHeader("Select authentication method:");
		this.addChild(new Text(`${theme.fg("accent", "→ ")}${theme.fg("accent", "Use an API key")}`, 1, 0));
		this.addHint(`${keyHint("tui.select.confirm", "select")} ${keyHint("tui.select.cancel", "cancel")}`);
	}

	private renderProviderSelector(): void {
		this.addHeader("Select provider to configure:");
		for (let index = 0; index < this.providers.length; index += 1) {
			const provider = this.providers[index];
			if (!provider) continue;
			const selected = index === this.providerIndex;
			const prefix = selected ? theme.fg("accent", "→ ") : "  ";
			const name = selected ? theme.fg("accent", provider.name) : theme.fg("text", provider.name);
			const status = provider.configured
				? theme.fg("success", " ✓ configured")
				: theme.fg("muted", " • unconfigured");
			this.addChild(new Text(prefix + name + status, 1, 0));
		}
		this.addHint(`${keyHint("tui.select.confirm", "select")} ${keyHint("tui.select.cancel", "back")}`);
	}

	private renderApiKeyDialog(): void {
		const provider = this.selectedProvider ?? this.providers[this.providerIndex] ?? defaultAuthProviders()[0]!;
		this.selectedProvider = provider;
		this.addHeader(`Login to ${provider.name}`);
		this.addChild(new Text(theme.fg("text", "Enter API key:"), 1, 0));
		this.addChild(new Text(`${theme.fg("muted", "> ")}${this.maskedApiKey()}${this.cursor()}`, 1, 0));
		this.addHint(`${keyHint("tui.select.cancel", "back,")} ${keyHint("tui.select.confirm", "save")}`);
	}

	private addHeader(title: string): void {
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	}

	private addHint(text: string): void {
		this.addChild(new Text(text, 1, 0));
		this.addChild(new Spacer(1));
	}

	private handleApiKeyInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.confirm")) {
			const apiKey = this.apiKey.trim();
			if (apiKey && this.selectedProvider) {
				this.onSubmitCallback({ providerId: this.selectedProvider.id, apiKey });
			}
			return;
		}
		if (kb.matches(keyData, "tui.editor.deleteCharBackward")) {
			this.apiKey = this.apiKey.slice(0, -1);
			this.rebuild();
			return;
		}
		if (!hasControlChars(keyData)) {
			this.apiKey += keyData;
			this.rebuild();
		}
	}

	private maskedApiKey(): string {
		return this.apiKey.length > 0 ? "•".repeat(this.apiKey.length) : theme.fg("dim", "API key");
	}

	private cursor(): string {
		return this._focused ? theme.fg("accent", "▌") : "";
	}
}

function hasControlChars(value: string): boolean {
	return [...value].some((ch) => {
		const code = ch.charCodeAt(0);
		return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
	});
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
