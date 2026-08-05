import assert from "node:assert/strict";
import test from "node:test";
import { formatShellResult } from "../src/index.ts";

test("Shell result preserves the completed response field order", () => {
	const result = formatShellResult({
		chunkId: "decafbad",
		wallTimeSeconds: 0.5,
		shellId: "a1b2c3d4",
		terminalState: "completed",
		exitCode: 0,
		output: "done",
		maxOutputTokens: 100,
	});
	const expected = [
		"Chunk ID: decafbad",
		"Wall time: 0.50 seconds",
		"Process exited with code 0",
		"Final output:",
		"done",
	].join("\n");

	assert.equal(result.modelOutput, expected);
	assert.equal(result.originalChars, expected.length);
	assert.equal(result.originalTokenCount, Math.ceil(expected.length / 4));
	assert.equal(result.retainedChars, expected.length);
	assert.equal(result.omittedChars, 0);
});

test("Shell result reports resumable live output without command or stdin", () => {
	const input = {
		chunkId: "c0ffee12",
		wallTimeSeconds: 10.01,
		shellId: "a1b2c3d4",
		terminalState: null,
		exitCode: null,
		output: "collecting tests...",
		maxOutputTokens: 100,
		command: "private command",
		chars: "private stdin",
	};
	const result = formatShellResult(input);

	assert.equal(result.modelOutput, [
		"Chunk ID: c0ffee12",
		"Wall time: 10.01 seconds",
		"Process running with session ID a1b2c3d4",
		"Live output:",
		"collecting tests...",
	].join("\n"));
	assert.equal(result.modelOutput.includes(input.command), false);
	assert.equal(result.modelOutput.includes(input.chars), false);
});

test("five-token Shell result uses stable head-tail truncation", () => {
	const output = "abcdefghijklmnopqrstuvwxyz";
	const result = formatShellResult({
		chunkId: "12345678",
		wallTimeSeconds: 1,
		shellId: "a1b2c3d4",
		terminalState: "completed",
		exitCode: 0,
		output,
		maxOutputTokens: 5,
	});

	assert.equal(result.modelOutput.length, 20);
	assert.equal(result.modelOutput.startsWith("Chu"), true);
	assert.equal(result.modelOutput.endsWith("yz"), true);
	assert.equal(result.modelOutput.includes("[chars omitted]"), true);
	assert.equal(result.originalTokenCount, Math.ceil(result.originalChars / 4));
	assert.equal(result.retainedChars, 5);
	assert.equal(result.omittedChars, result.originalChars - result.retainedChars);
	assert.equal(output, "abcdefghijklmnopqrstuvwxyz");
});
