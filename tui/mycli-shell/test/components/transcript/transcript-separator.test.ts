import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import test from "node:test";
import { AssistantMessageComponent } from "../../../src/components/transcript/assistant-message.ts";
import { TranscriptSeparatorComponent } from "../../../src/components/transcript/transcript-separator.ts";
import { TranscriptViewerComponent } from "../../../src/components/transcript/transcript-viewer.ts";
import type { MycliShellState, MycliShellTranscriptBlock } from "../../../src/model.ts";
import {
	renderTranscriptBlocks,
} from "../../../src/components/transcript/transcript-renderer.ts";
import {
	MycliShellRuntime,
} from "../../../src/application/shell-runtime.ts";
import { setUiGlyphMode, uiGlyphMode, uiGlyphs } from "../../../src/theme/terminal-style.ts";
import { visibleWidth } from "../../../src/tui-core/utils.ts";
import { HeadlessTerminal } from "../../support/headless-terminal.ts";

test("transcript separator fills its width with Unicode or ASCII glyphs", () => {
	const previous = uiGlyphMode();
	try {
		for (const mode of ["unicode", "ascii"] as const) {
			setUiGlyphMode(mode);
			const separator = new TranscriptSeparatorComponent();
			for (const width of [0, 1, 18, 80, 160]) {
				const lines = separator.render(width).map(stripAnsi);
				assert.deepEqual(lines, width === 0 ? [] : ["", uiGlyphs().horizontal.repeat(width)]);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
			}
		}
	} finally {
		setUiGlyphMode(previous);
	}
});

test("inline and historical transcript rendering place one divider before assistant prose", () => {
	const blocks = workAndAnswer("answer-marker\n\nAnother paragraph.");
	for (const width of [22, 50, 100]) {
		const lines = renderTranscriptBlocks(blocks, width).map(stripAnsi);
		assertDividerBeforeAnswer(lines, width);
		const divider = lines.findIndex(isDivider);
		assert.equal(lines[divider]?.length, width);
		assert.equal(lines[divider - 1]?.trim(), "");
		assert.equal(lines[divider + 1]?.trim(), "");
		assert.equal(lines[divider + 2]?.trim(), "\u2022 answer-marker");

		const viewer = new TranscriptViewerComponent({ blocks, rows: () => 30, onClose: () => {} });
		const historical = viewer.render(width).map(stripAnsi);
		assertDividerBeforeAnswer(historical, width);
		assert.ok(historical.every((line) => visibleWidth(line) < width));
	}
});

test("streaming retains the assistant and separator components through tail updates", async (context) => {
	const terminal = new HeadlessTerminal();
	const runtime = new MycliShellRuntime({ initialState: stateFor(workAndAnswer("")), terminal });
	context.after(async () => { await runtime.shutdown(); terminal.dispose(); });
	assert.equal(runtime.chatContainer.children.some((child) => child instanceof TranscriptSeparatorComponent), false);
	const assistant = runtime.chatContainer.children.find((child) => child instanceof AssistantMessageComponent);

	runtime.setState(stateFor(workAndAnswer("answer-marker")), { transcriptUpdate: "tail" });
	const separator = runtime.chatContainer.children.find((child) => child instanceof TranscriptSeparatorComponent);
	assert.ok(separator);
	const children = runtime.chatContainer.children;
	for (const text of ["answer-marker continued", "answer-marker continued\n\nNext paragraph."]) {
		runtime.setState(stateFor(workAndAnswer(text)), { transcriptUpdate: "tail" });
		assert.equal(runtime.chatContainer.children, children);
		assert.equal(runtime.chatContainer.children.filter((child) => child instanceof TranscriptSeparatorComponent).length, 1);
		assert.ok(runtime.chatContainer.children.includes(separator));
		assert.ok(assistant && runtime.chatContainer.children.includes(assistant));
		assertDividerBeforeAnswer(runtime.chatContainer.render(60).map(stripAnsi), 60);
	}
});

test("native terminal keeps a single work divider through streaming and resize", async (context) => {
	const terminal = new HeadlessTerminal({ columns: 72, rows: 20, nativeScrollback: true, scrollback: 300 });
	let text = "answer-marker";
	const runtime = new MycliShellRuntime({ initialState: stateFor(workAndAnswer(text)), terminal });
	context.after(async () => {
		await runtime.shutdown();
		await terminal.flush();
		terminal.dispose();
	});
	runtime.start();
	await delay(30);
	await terminal.flush();
	assertDividerBeforeAnswer(terminal.bufferLines(), terminal.columns);

	for (const width of [32, 96, 48]) {
		terminal.resize(width, 20);
		for (let index = 0; index < 6; index += 1) {
			text += `\n\nParagraph ${width}-${index}: \u4e2d\u6587 text continues.`;
			runtime.setState(stateFor(workAndAnswer(text)), { transcriptUpdate: "tail" });
		}
		await delay(120);
		await terminal.flush();
		assertDividerBeforeAnswer(terminal.bufferLines(), width);
	}
});

function workAndAnswer(text: string): MycliShellTranscriptBlock[] {
	return [
		{ id: "user", kind: "message", message: { id: "user", role: "user", text: "Inspect the file." } },
		{ id: "read", kind: "tool", tool: {
			id: "read", name: "Read", args: "notes.md", status: "success", presentation: "context",
		} },
		{ id: "answer", kind: "message", message: { id: "answer", role: "assistant", text } },
	];
}

function stateFor(transcript: MycliShellTranscriptBlock[]): MycliShellState {
	return {
		messages: transcript.flatMap((block) => block.kind === "message" ? [block.message] : []),
		tools: transcript.flatMap((block) => block.kind === "tool" ? [block.tool] : []),
		bash: [],
		transcript,
		footer: { cwd: "/workspace", liveState: "Running", turnRunning: true },
	};
}

function assertDividerBeforeAnswer(lines: string[], width: number): void {
	const work = lines.findIndex((line) => line.includes("notes.md"));
	const answer = lines.findIndex((line) => line.includes("answer-marker"));
	assert.ok(work >= 0 && answer > work, `missing or reordered transcript rows:\n${lines.join("\n")}`);
	const dividers = lines.slice(work + 1, answer).filter(isDivider);
	assert.equal(dividers.length, 1, `expected one work divider:\n${lines.join("\n")}`);
	assert.ok(visibleWidth(dividers[0]!) <= width);
	assert.equal(lines.filter((line) => line.includes("answer-marker")).length, 1);
}

function isDivider(line: string): boolean {
	return /^(?:\u2500|-)+$/u.test(line.trim());
}
