import { Container, getKeybindings, Spacer, Text } from "../tui-core/index.ts";
import { uiGlyphs } from "../theme/terminal-style.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

interface StartupStepActions {
	readonly onContinue: () => void;
	readonly onCancel: () => void;
}

export class WelcomeStepComponent extends Container {
	readonly #onContinue: () => void;
	readonly #onCancel: () => void;

	constructor(actions: StartupStepActions) {
		super();
		this.#onContinue = actions.onContinue;
		this.#onCancel = actions.onCancel;
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Welcome to mycli")), 1, 0));
		this.addChild(new Text("Configure a provider, choose how the model runs, and review this workspace.", 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${theme.fg("accent", `${uiGlyphs().selector} `)}${theme.bold("Continue")}`, 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(
			`${keyHint("tui.select.confirm", "continue")}  ${keyHint("tui.select.cancel", "exit")}`,
			1,
			0,
		));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.#onContinue();
		} else if (keybindings.matches(keyData, "tui.select.cancel")) {
			this.#onCancel();
		}
	}
}

export interface ConnectivityStepOptions {
	readonly validationAvailable: boolean;
	readonly onSkip: () => void;
	readonly onValidate: () => void;
	readonly onCancel: () => void;
}

export class ConnectivityStepComponent extends Container {
	readonly #options: ConnectivityStepOptions;
	#selectedIndex = 0;
	#pending = false;
	#error = "";

	constructor(options: ConnectivityStepOptions) {
		super();
		this.#options = options;
		this.#rebuild();
	}

	setPending(pending: boolean): void {
		this.#pending = pending;
		this.#error = "";
		this.#rebuild();
	}

	setError(message: string): void {
		this.#pending = false;
		this.#error = message.trim() || "Connection check failed.";
		this.#rebuild();
	}

	handleInput(keyData: string): void {
		if (this.#pending) return;
		const keybindings = getKeybindings();
		if (keybindings.matches(keyData, "tui.select.up")) {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
		} else if (keybindings.matches(keyData, "tui.select.down")) {
			this.#selectedIndex = Math.min(1, this.#selectedIndex + 1);
		} else if (keybindings.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			if (this.#selectedIndex === 0) this.#options.onSkip();
			else if (this.#options.validationAvailable) this.#options.onValidate();
		} else if (keybindings.matches(keyData, "tui.select.cancel")) {
			this.#options.onCancel();
		}
		this.#error = "";
		this.#rebuild();
	}

	#rebuild(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Check provider connection")), 1, 0));
		this.addChild(new Text(
			theme.fg("muted", "This sends one small request. Setup can remain offline."),
			1,
			0,
		));
		this.addChild(new Spacer(1));
		this.#addOption(0, "Skip for now", "No network request");
		this.#addOption(
			1,
			this.#options.validationAvailable ? "Test connection" : "Test connection (unavailable)",
			"Verify the selected provider and credential",
			!this.#options.validationAvailable,
		);
		if (this.#pending) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("warning", "  Testing provider connection..."), 1, 0));
		}
		if (this.#error) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("error", `  ${this.#error}`), 1, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(
			`${rawKeyHint(`${uiGlyphs().up}${uiGlyphs().down}`, "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "exit")}`,
			1,
			0,
		));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	#addOption(index: number, label: string, description: string, disabled = false): void {
		const selected = index === this.#selectedIndex;
		const prefix = selected ? theme.fg("accent", `${uiGlyphs().selector} `) : "  ";
		const text = disabled
			? theme.fg("muted", label)
			: selected ? theme.fg("accent", theme.bold(label)) : label;
		this.addChild(new Text(`${prefix}${text}`, 1, 0));
		this.addChild(new Text(theme.fg("muted", `    ${description}`), 1, 0));
	}
}

export interface ReadyStepOptions extends StartupStepActions {
	readonly provider?: string;
	readonly model?: string;
	readonly permission?: string;
	readonly trusted: boolean;
}

export class ReadyStepComponent extends Container {
	readonly #onContinue: () => void;
	readonly #onCancel: () => void;

	constructor(options: ReadyStepOptions) {
		super();
		this.#onContinue = options.onContinue;
		this.#onCancel = options.onCancel;
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("success", theme.bold("Ready to use mycli")), 1, 0));
		this.addChild(new Spacer(1));
		if (options.provider) this.#addSummary("Provider", options.provider);
		if (options.model) this.#addSummary("Model", options.model);
		if (options.permission) this.#addSummary("Permissions", options.permission);
		this.#addSummary("Workspace", options.trusted ? "trusted" : "not trusted");
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${theme.fg("accent", `${uiGlyphs().selector} `)}${theme.bold("Open composer")}`, 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(
			`${keyHint("tui.select.confirm", "start")}  ${keyHint("tui.select.cancel", "exit")}`,
			1,
			0,
		));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.#onContinue();
		} else if (keybindings.matches(keyData, "tui.select.cancel")) {
			this.#onCancel();
		}
	}

	#addSummary(label: string, value: string): void {
		this.addChild(new Text(`  ${theme.fg("muted", `${label}:`)} ${value}`, 1, 0));
	}
}
