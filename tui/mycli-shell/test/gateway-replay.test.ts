import assert from "node:assert/strict";
import test from "node:test";
import { renderMycliShell } from "../src/index.ts";
import { initialRuntimeState, projectRuntimeState, runtimeStateFromTranscript } from "../src/adapters/runtime-state.ts";
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
	assert.equal(occurrences(output, "Thinking..."), 0);
});

test("recorded shell lifecycle recovers Running output and terminal Ran state", () => {
	const events = loadGatewayReplay("shell-lifecycle-recovery.jsonl");
	const runningShell = projectRuntimeState(replayGatewayEvents(events.slice(0, 1)));
	const outputShell = projectRuntimeState(replayGatewayEvents(events.slice(0, 2)));
	const completedShell = projectRuntimeState(replayGatewayEvents(events));
	const runningOutput = stripAnsi(renderMycliShell(runningShell, 100).join("\n"));
	const outputOutput = stripAnsi(renderMycliShell(outputShell, 100).join("\n"));
	const completedOutput = stripAnsi(renderMycliShell(completedShell, 100).join("\n"));

	assert.equal(runningShell.footer.backgroundShellCount, 1);
	assert.match(runningOutput, /• Running uv run dev/);
	assert.match(runningOutput, /1 background terminal running/);
	assert.match(outputOutput, /ready/);
	assert.equal(completedShell.footer.backgroundShellCount, 0);
	assert.match(completedOutput, /• Ran uv run dev/);
	assert.doesNotMatch(completedOutput, /background terminal running/);
});

test("historical Shell transcript uses the compact completed output summary", () => {
	const retainedOutput = Array.from({ length: 7 }, (_, index) => `history output ${index + 1}`).join("\n");
	const state = runtimeStateFromTranscript(initialRuntimeState(), {
		items: [
			{
				id: "historical-shell-1",
				type: "tool_summary",
				text: "Shell generate history",
				folded: true,
				metadata: {
					tool_name: "Shell",
					command: "generate history",
					success: true,
					output_preview: retainedOutput,
				},
			},
		],
	});

	const output = stripAnsi(renderMycliShell(projectRuntimeState(state), 100).join("\n"));

	assert.match(output, /history output 1/);
	assert.doesNotMatch(output, /history output 3/);
	assert.match(output, /3 more lines/);
	assert.match(output, /history output 7/);
});

function stripAnsi(text: string): string {
	return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "");
}

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}
