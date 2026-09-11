import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createNativeAuthInteraction } from "../src/management/auth-interaction.ts";

class TerminalInput extends PassThrough {
	readonly isTTY = true;
	isRaw = false;
	setRawMode(value: boolean): this { this.isRaw = value; return this; }
}

test("OAuth secret and manual-code prompts do not echo input and restore terminal mode", async () => {
	for (const type of ["secret", "manual_code"] as const) {
		const input = new TerminalInput();
		const output: string[] = [];
		const interaction = createNativeAuthInteraction({ input, output: { write: (value) => output.push(value) }, signal: new AbortController().signal });
		const answer = interaction.prompt({ type, message: "Authorization code" });
		input.write("private-code\r");
		assert.equal(await answer, "private-code");
		assert.doesNotMatch(output.join(""), /private-code/u);
		assert.match(output.join(""), /Authorization code/u);
		assert.equal(input.isRaw, false);
		input.destroy();
	}
});

test("OAuth prompts restore terminal mode on cancellation, Ctrl+C and EOF", async () => {
	for (const mode of ["signal", "prompt_signal", "ctrl_c", "eof"] as const) {
		const input = new TerminalInput();
		const controller = new AbortController();
		const promptController = new AbortController();
		const interaction = createNativeAuthInteraction({ input, output: { write: () => undefined }, signal: controller.signal });
		const answer = interaction.prompt({ type: "manual_code", message: "Authorization code", signal: promptController.signal });
		const rejected = assert.rejects(answer, { name: "AbortError" });
		if (mode === "signal") controller.abort();
		else if (mode === "prompt_signal") promptController.abort();
		else if (mode === "ctrl_c") input.write("\x03");
		else input.end();
		await rejected;
		assert.equal(input.isRaw, false);
		input.destroy();
	}
});

test("OAuth selection accepts the displayed option index", async () => {
	const input = new TerminalInput();
	const interaction = createNativeAuthInteraction({ input, output: { write: () => undefined }, signal: new AbortController().signal });
	const answer = interaction.prompt({ type: "select", message: "Account", options: [{ id: "personal", label: "Personal" }, { id: "work", label: "Work" }] });
	input.write("2\r");
	assert.equal(await answer, "work");
	input.destroy();
});
