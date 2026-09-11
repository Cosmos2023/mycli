import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { renderShellCompletion } from "../src/management/completion.ts";

const executeFile = promisify(execFile);

test("bash completes nested marketplace operations and their options at the correct depth", { skip: process.platform === "win32" }, async () => {
	for (const [words, cursor, expected, absent] of [
		["mycli plugins marketplace up", 3, "upgrade", "update"],
		["mycli plugins marketplace add --r", 4, "--ref", "--marketplace"],
		["mycli plugins list --a", 3, "--available", "upgrade"],
	] as const) {
		const { stdout } = await executeFile("bash", ["--noprofile", "--norc", "-c", [
			renderShellCompletion("bash"), `COMP_WORDS=(${words})`, `COMP_CWORD=${cursor}`,
			"_mycli_completion", 'printf "%s\\n" "${COMPREPLY[@]}"',
		].join("\n")]);
		const candidates = stdout.trim().split("\n");
		assert.ok(candidates.includes(expected));
		assert.ok(!candidates.includes(absent));
	}
});

test("zsh nested marketplace completions parse and reach the selected node", { skip: process.platform !== "darwin" }, async () => {
	const { stdout } = await executeFile("zsh", ["-f", "-c", [
		"compdef() { :; }", '_describe() { print -rl -- "${candidates[@]}"; }',
		renderShellCompletion("zsh"), "words=(mycli plugins marketplace add --r)", "CURRENT=5", "_mycli",
	].join("\n")]);
	assert.match(stdout, /--ref/u);
	assert.doesNotMatch(stdout, /--marketplace/u);
});
