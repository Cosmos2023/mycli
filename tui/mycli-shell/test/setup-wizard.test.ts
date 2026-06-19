import assert from "node:assert/strict";
import test from "node:test";
import { SetupWizardComponent, type SetupWizardResult } from "../src/components/setup-wizard.ts";
import type { Terminal } from "../src/tui-core/terminal.ts";
import { TUI } from "../src/tui-core/tui.ts";

class TestTerminal implements Terminal {
	columns = 100;
	rows = 30;
	kittyProtocolActive = false;
	nativeScrollback = false;
	output = "";
	input?: (data: string) => void;
	started = false;
	stopped = false;

	start(onInput: (data: string) => void): void {
		this.input = onInput;
		this.started = true;
	}

	stop(): void {
		this.stopped = true;
		this.started = false;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.output += data;
	}

	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

function press(terminal: TestTerminal, key: string): void {
	terminal.input?.(key);
}

test("setup wizard collects provider endpoint model and api key", () => {
	const terminal = new TestTerminal();
	const ui = new TUI(terminal);
	let result: SetupWizardResult | undefined;
	const wizard = new SetupWizardComponent({
		tui: ui,
		state: {
			providers: [
				{
					id: "openai",
					name: "OpenAI",
					default_model: "gpt-5",
					default_base_url: "https://api.openai.com/v1",
					protocol: "responses",
				},
				{
					id: "deepseek",
					name: "DeepSeek",
					default_model: "deepseek-chat",
					default_base_url: "https://api.deepseek.com",
					protocol: "chat_completions",
				},
			],
			config_path: "/tmp/home/.mycli/config.toml",
			auth_path: "/tmp/home/.mycli/auth.json",
		},
		onSubmit: (next) => {
			result = next;
		},
		onCancel: () => {},
	});
	ui.addChild(wizard);
	ui.setFocus(wizard);
	ui.start();

	press(terminal, "\r"); // auth
	press(terminal, "\x1b[B"); // DeepSeek
	press(terminal, "\r"); // provider
	press(terminal, "\r"); // default base URL
	press(terminal, "\r"); // default model
	for (const char of "sk-test") press(terminal, char);
	press(terminal, "\r"); // review
	press(terminal, "\r"); // save

	assert.deepEqual(result, {
		provider: "deepseek",
		api_base_url: "https://api.deepseek.com",
		model: "deepseek-chat",
		api_key: "sk-test",
	});
	ui.stop();
});
