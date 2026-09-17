import assert from "node:assert/strict";
import test from "node:test";
import * as shell from "../src/index.ts";
import type { Terminal } from "../src/tui-core/terminal.ts";

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
	write(data: string): void { this.output += data; }
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

type RunSetupTui = (options: {
	readonly state: {
		readonly providers: readonly {
			readonly id: string;
			readonly name: string;
			readonly default_model?: string;
			readonly default_base_url?: string;
		}[];
	};
	readonly terminal: Terminal;
}) => Promise<{
	readonly provider: string;
	readonly api_base_url: string;
	readonly model: string;
	readonly api_key: string;
} | undefined>;

test("setup TUI returns its result directly and stops terminal ownership", async () => {
	const runSetupTui = (shell as unknown as { runSetupTui?: RunSetupTui }).runSetupTui;
	assert.equal(typeof runSetupTui, "function");
	const terminal = new TestTerminal();
	const completion = runSetupTui!({
		state: {
			providers: [{
				id: "anthropic",
				name: "Anthropic",
				default_model: "claude-sonnet-4-6",
				default_base_url: "https://api.anthropic.com",
			}],
		},
		terminal,
	});

	press(terminal, "\r");
	press(terminal, "\r");
	press(terminal, "\r");
	press(terminal, "\r");
	for (const char of "secret-value") press(terminal, char);
	press(terminal, "\r");
	press(terminal, "\r");

	assert.deepEqual(await completion, {
		provider: "anthropic",
		api_base_url: "https://api.anthropic.com",
		model: "claude-sonnet-4-6",
		api_key: "secret-value",
	});
	assert.equal(terminal.stopped, true);
});

test("setup TUI uses the current OpenAI and Codex defaults without provider metadata", async () => {
	for (const provider of ["openai", "codex"]) {
		const terminal = new TestTerminal();
		const completion = shell.runSetupTui({ state: { providers: [] }, terminal });
		press(terminal, "\r");
		if (provider === "codex") press(terminal, "\x1b[B");
		press(terminal, "\r");
		press(terminal, "\r");
		press(terminal, "\r");
		press(terminal, "secret-value");
		press(terminal, "\r");
		press(terminal, "\r");
		assert.deepEqual(await completion, {
			provider,
			api_base_url: "https://api.openai.com/v1",
			model: "gpt-5.5",
			api_key: "secret-value",
		});
		assert.equal(terminal.stopped, true);
	}
});

test("setup TUI resolves cancellation without producing a result", async () => {
	const runSetupTui = (shell as unknown as { runSetupTui?: RunSetupTui }).runSetupTui;
	assert.equal(typeof runSetupTui, "function");
	const terminal = new TestTerminal();
	const completion = runSetupTui!({ state: { providers: [] }, terminal });

	press(terminal, "\x1b");

	assert.equal(await completion, undefined);
	assert.equal(terminal.stopped, true);
});

function press(terminal: TestTerminal, key: string): void {
	terminal.input?.(key);
}
