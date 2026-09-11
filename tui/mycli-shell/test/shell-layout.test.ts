import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { BashExecutionComponent } from "../src/components/transcript/bash-execution.ts";
import type { MycliShellBash, MycliShellState, MycliShellTranscriptBlock } from "../src/model.ts";
import {
	renderTranscriptBlocks,
} from "../src/components/transcript/transcript-renderer.ts";
import {
	MycliShellRuntime,
} from "../src/application/shell-runtime.ts";
import { visibleWidth } from "../src/tui-core/utils.ts";
import { HeadlessTerminal } from "./support/headless-terminal.ts";

test("adjacent Shell blocks have one blank row regardless of output boundary whitespace", () => {
	for (const expanded of [false, true]) {
		for (const status of ["running", "success", "error"] as const) {
			for (const width of [24, 80, 120]) {
				for (const outputPreview of [undefined, "", "\n\n", "first", "first\n", "first\n \n", "\nfirst\r\n\r\n", "\u001b[31mfirst\u001b[0m\n\u001b[0m\n"]) {
					const bash: MycliShellBash = { id: "first", command: "command-one", status, outputPreview, expanded };
					const blocks: MycliShellTranscriptBlock[] = [
						{ id: bash.id, kind: "bash", bash },
						{ id: "second", kind: "bash", bash: { id: "second", command: "command-two", status: "success" } },
					];
					const lines = renderTranscriptBlocks(blocks, width).map(stripAnsi);
					const second = lines.findIndex((line) => line.includes("Ran command-two"));
					assert.ok(second > 1);
					assert.equal(lines[second - 1]?.trim(), "");
					assert.notEqual(lines[second - 2]?.trim(), "", `extra Shell gap: ${JSON.stringify({ status, expanded, outputPreview, width, lines })}`);
					assert.equal(bash.outputPreview, outputPreview);
				}
			}
		}
	}
});

test("Shell previews retain interior blank rows and indentation while streaming", () => {
	const bash: MycliShellBash = { id: "shell", command: "show-output", status: "running" };
	const component = new BashExecutionComponent(bash);
	for (const expanded of [false, true]) {
		component.updateBash({ ...bash, expanded, outputPreview: "\n\n  first\n\n    second\n\n" });
		const lines = component.render(80).map(stripAnsi);
		const first = lines.findIndex((line) => line.includes("first"));
		assert.match(lines[first]!, /\u2514 {3}first/u);
		assert.equal(lines[first + 1]?.trim(), "");
		assert.match(lines[first + 2]!, /^ {8}second/u);
		assert.ok(lines.at(-1)?.includes("second"));
		component.updateBash({ ...bash, expanded, outputPreview: "\n\n  first\n\n    second\n\nthird\n" });
		assert.ok(stripAnsi(component.render(80).at(-1) ?? "").includes("third"));
	}
	component.updateBash({ ...bash, outputPreview: "\n \n\u001b[0m\n" });
	assert.equal(component.render(80).length, 2);
});

test("a blank Shell preview retains the hint for older omitted output", () => {
	const component = new BashExecutionComponent({
		id: "shell", command: "show-output", status: "success", outputPreview: "\n\n", hiddenLineCount: 42,
	});
	const lines = component.render(80).map(stripAnsi);
	assert.equal(lines.length, 3);
	assert.match(lines[2]!, /\+42 lines .*to view transcript/u);
});

test("turn activity stays above the composer during transcript scrolling and state-only updates", async (context) => {
	const terminal = new HeadlessTerminal({ columns: 80, rows: 24 });
	const runtime = new MycliShellRuntime({ initialState: stateFor(shellBlocks(30)), terminal, now: () => 10_000 });
	context.after(async () => { await runtime.shutdown(); terminal.dispose(); });
	runtime.editor.setText("composer-marker");
	assert.equal(runtime.statusContainer.render(80).length, 3);
	const activity = runtime.statusContainer.children[0];
	assert.ok(activity);
	assert.doesNotMatch(stripAnsi(runtime.chatContainer.render(80).join("\n")), /esc to interrupt/u);
	assertActivityAboveComposer(runtime.ui.render(80).map(stripAnsi));
	runtime.transcriptViewport.scrollBy(15);
	assertActivityAboveComposer(runtime.ui.render(80).map(stripAnsi));
	const transcriptLines = runtime.transcriptViewport.render(80);
	const transcriptRevision = runtime.chatContainer.getRenderCacheKey();
	runtime.setState({ ...runtime.getState(), footer: { ...runtime.getState().footer, liveState: "Compressing context", liveStateKind: "compaction" } });
	assert.equal(runtime.statusContainer.children[0], activity);
	assert.equal(runtime.chatContainer.getRenderCacheKey(), transcriptRevision);
	assert.deepEqual(runtime.transcriptViewport.render(80), transcriptLines);
	for (const width of [8, 24, 40, 80]) {
		const lines = runtime.statusContainer.render(width);
		assert.equal(lines.length, 3, `activity height changed at width ${width}`);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	runtime.setState({ ...runtime.getState(), footer: { ...runtime.getState().footer, turnRunning: false } });
	assert.doesNotMatch(stripAnsi(runtime.statusContainer.render(80).join("\n")), /esc to interrupt/u);
});

test("native terminal keeps one activity row out of history through Shell output, queue changes and resize", async (context) => {
	const terminal = new HeadlessTerminal({ columns: 80, rows: 24, nativeScrollback: true, scrollback: 500 });
	let transcript = shellBlocks(30);
	const runtime = new MycliShellRuntime({ initialState: stateFor(transcript), terminal, now: () => 10_000 });
	context.after(async () => { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); });
	runtime.editor.setText("composer-marker");
	runtime.start();
	for (const width of [80, 40, 100, 56]) {
		terminal.resize(width, 24);
		transcript = [...transcript, ...shellBlocks(3, transcript.length)];
		runtime.setState(stateFor(transcript), { transcriptUpdate: "tail" });
		await delay(120);
		await terminal.flush();
		assertActivityAboveComposer(terminal.visibleLines());
		assert.doesNotMatch(terminal.historyLines().join("\n"), /esc to interrupt/u);
		runtime.setState({ ...runtime.getState(), pendingInput: {
			pendingSteers: [], rejectedSteers: [],
			followUps: [{ queueId: "queued", kind: "follow_up", text: "queued-marker", hasImages: false, state: "queued" }],
		} });
		await delay(30);
		await terminal.flush();
		assertActivityAboveComposer(terminal.visibleLines());
		assert.doesNotMatch(terminal.historyLines().join("\n"), /esc to interrupt/u);
	}
	runtime.setState({ ...runtime.getState(), pendingInput: undefined, footer: { ...runtime.getState().footer, liveState: "Completed", liveStateKind: "completed", turnRunning: false, turnDurationMs: 2_000 } });
	await delay(30);
	await terminal.flush();
	assert.doesNotMatch(terminal.bufferLines().join("\n"), /esc to interrupt/u);
});

function shellBlocks(count: number, offset = 0): MycliShellTranscriptBlock[] {
	return Array.from({ length: count }, (_, index) => {
		const id = `shell-${offset + index}`;
		return { id, kind: "bash", bash: { id, command: `command-${offset + index}`, status: "success", outputPreview: `result-${offset + index}\n\n` } };
	});
}

function stateFor(transcript: MycliShellTranscriptBlock[]): MycliShellState {
	return {
		messages: [], tools: [], bash: [], transcript,
		footer: { cwd: "/workspace", liveState: "Working", liveStateKind: "running", turnRunning: true },
		settings: { reducedMotion: true },
	};
}

function assertActivityAboveComposer(lines: string[]): void {
	const activity = lines.findIndex((line) => line.includes("esc to interrupt"));
	const composer = lines.findIndex((line) => line.includes("composer-marker"));
	assert.ok(activity >= 0 && composer > activity, lines.join("\n"));
	assert.equal(lines.filter((line) => line.includes("esc to interrupt")).length, 1);
	assert.equal(lines[activity - 1]?.trim(), "");
	assert.equal(lines[activity + 1]?.trim(), "");
	assert.ok(composer - activity <= 3, lines.join("\n"));
}
