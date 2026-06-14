import assert from "node:assert/strict";
import test from "node:test";
import { renderMycliShell } from "../src/index.ts";
import { projectRuntimeState } from "../src/adapters/runtime-state.ts";
import { loadGatewayReplay, replayGatewayEvents } from "./support/gateway-replay.ts";

test("recorded duplicate gateway mirrors replay as one assistant answer", () => {
	const events = loadGatewayReplay("duplicate-assistant-answer.jsonl");
	const state = replayGatewayEvents(events);
	const shell = projectRuntimeState(state);
	const assistantMessages = shell.messages.filter((message) => message.role === "assistant" && message.text.trim());
	const output = stripAnsi(renderMycliShell(shell, 100).join("\n"));

	assert.equal(assistantMessages.length, 1);
	assert.equal(assistantMessages[0]?.text, "我是 mycli，你的本地编程助手。已经在待命了，有具体任务直接说。");
	assert.equal(occurrences(output, "我是 mycli，你的本地编程助手。已经在待命了，有具体任务直接说。"), 1);
	assert.equal(occurrences(output, "Thinking..."), 1);
});

function stripAnsi(text: string): string {
	return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "");
}

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}
