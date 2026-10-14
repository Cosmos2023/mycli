import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import {
	initialRuntimeState,
} from "../src/state/runtime-state-model.ts";
import {
	projectRuntimeState,
} from "../src/state/runtime-projection.ts";
import type { MycliShellState, MycliShellTranscriptBlock } from "../src/model.ts";
import {
	MycliShellRuntime,
} from "../src/application/shell-runtime.ts";
import { HeadlessTerminal } from "./support/headless-terminal.ts";

test("Ctrl+C and the transcript toggle close the viewer without interrupting a running turn", async (t) => {
	for (const key of ["\x03", "\x14"]) {
		const terminal = new HeadlessTerminal();
		let interrupts = 0;
		const state = shellState([]);
		const runtime = new MycliShellRuntime({
			initialState: { ...state, footer: { ...state.footer, turnRunning: true, liveState: "Running" } },
			terminal, onInterrupt: () => { interrupts += 1; },
		});
		t.after(async () => { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); });
		runtime.start();
		runtime.showTranscriptViewer();
		assert.equal(runtime.ui.hasOverlay(), true);
		terminal.sendInput(key);
		assert.equal(runtime.ui.hasOverlay(), false);
		assert.equal(interrupts, 0);
		assert.equal(runtime.getState().footer.turnRunning, true);
		terminal.sendInput("\x03");
		await waitUntil(() => interrupts === 1);
	}
});

test("large transcripts navigate retained Shell output and keep main-view folding intact", async (t) => {
	const terminal = new HeadlessTerminal({ rows: 30 });
	const blocks = shellBlocks(200);
	const runtime = new MycliShellRuntime({
		initialState: shellState(blocks), terminal,
	});
	t.after(async () => {
		await runtime.shutdown(); await terminal.flush(); terminal.dispose();
	});
	runtime.start();
	runtime.showTranscriptViewer();
	await waitUntil(() => terminal.visibleLines().some((line) => line.includes("retained-output-199")));
	await terminal.flush();
	assert.match(terminal.visibleLines().join("\n"), /retained-output-199/u);
	terminal.sendInput("g");
	await waitUntil(() => terminal.visibleLines().some((line) => /retained-output-0\b/u.test(line)));
	await terminal.flush();
	assert.match(terminal.visibleLines().join("\n"), /retained-output-0\b/u);
	terminal.resize(60, 20);
	await setTimeout(100);
	await waitUntil(() => terminal.visibleLines().some((line) => /retained-output-0\b/u.test(line)));
	await terminal.flush();
	assert.match(terminal.visibleLines().join("\n"), /retained-output-0\b/u);
	terminal.sendInput("G");
	await waitUntil(() => terminal.visibleLines().some((line) => line.includes("retained-output-199")));
	await terminal.flush();
	assert.match(terminal.visibleLines().join("\n"), /retained-output-199/u);
	runtime.closeTranscriptViewer();
	assert.equal(runtime.ui.hasOverlay(), false);
	assert.deepEqual(runtime.getState().transcript, blocks);
});

test("the transcript viewer loads stored Shell output and pages it with r", async (t) => {
	const terminal = new HeadlessTerminal({ rows: 30 });
	const requests: { shellId: string; afterSequence?: number }[] = [];
	const pageBody = `${"y".repeat(65_000)}\n`;
	const runtime = new MycliShellRuntime({
		initialState: shellState([{
			id: "shell-big",
			kind: "bash",
			bash: {
				id: "shell-big",
				shellId: "shell-big",
				callId: "call-big",
				command: "npm test",
				status: "success",
				outputPreview: "preview only",
				hiddenLineCount: 40,
				outputChars: 400_000,
			},
		}]),
		terminal,
		onShellOutputLoad: async (request) => {
			requests.push({
				shellId: request.shellId,
				...(request.afterSequence === undefined ? {} : { afterSequence: request.afterSequence }),
			});
			const after = request.afterSequence ?? 0;
			if (after >= 5) {
				return {
					chunks: [{ sequence: 6, output: "final stored page\n", omittedBefore: 0, cursorEnd: 400_000 }],
					nextAfterSequence: null,
					outputChars: 400_000,
				};
			}
			const sequence = after + 1;
			return {
				chunks: [{
					sequence,
					output: `stored page ${sequence}\n${pageBody}`,
					omittedBefore: 0,
					cursorEnd: sequence * 65_030,
				}],
				nextAfterSequence: sequence,
				outputChars: 400_000,
			};
		},
	});
	t.after(async () => { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); });
	runtime.start();
	runtime.showTranscriptViewer();

	// Opening the viewer reads stored output for the block on screen, up to the row budget.
	await waitUntil(() => requests.length === 5);
	await terminal.flush();
	assert.deepEqual(requests.map((entry) => entry.afterSequence ?? 0), [0, 1, 2, 3, 4]);

	terminal.sendInput("g");
	await waitUntil(() => terminal.visibleLines().some((line) => line.includes("r to load more")));
	await terminal.flush();
	assert.match(terminal.visibleLines().join("\n"), /75K chars not loaded \(r to load more\)/u);
	assert.match(terminal.visibleLines().join("\n"), /stored page 1/u);

	// `r` reads the next page; the marker disappears once the store runs out.
	terminal.sendInput("r");
	await waitUntil(() => requests.length === 6);
	terminal.sendInput("G");
	await waitUntil(() => terminal.visibleLines().some((line) => line.includes("final stored page")));
	await terminal.flush();
	assert.deepEqual(requests.map((entry) => entry.afterSequence ?? 0), [0, 1, 2, 3, 4, 5]);
	terminal.sendInput("g");
	await waitUntil(() => terminal.visibleLines().some((line) => line.includes("stored page 1")));
	await terminal.flush();
	assert.doesNotMatch(terminal.visibleLines().join("\n"), /r to load more/u);
});

test("changing sessions closes the viewer and reopening uses the new retained output", async (t) => {
	const terminal = new HeadlessTerminal();
	const runtime = new MycliShellRuntime({
		initialState: shellState(shellBlocks(1)), terminal,
	});
	t.after(async () => { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); });
	runtime.start();
	runtime.showTranscriptViewer();
	await waitUntil(() => terminal.visibleLines().some((line) => line.includes("retained-output-0")));
	await terminal.flush();
	assert.match(terminal.visibleLines().join("\n"), /retained-output-0/u);
	const blocks = shellBlocks(1).map((block) => block.kind === "bash"
		? { ...block, bash: { ...block.bash, outputPreview: "new-session-output" } } : block);
	runtime.setState({ ...shellState(blocks), sessionId: "new-session" });
	assert.equal(runtime.ui.hasOverlay(), false);
	runtime.showTranscriptViewer();
	await waitUntil(() => terminal.visibleLines().some((line) => line.includes("new-session-output")));
	await terminal.flush();
	assert.match(terminal.visibleLines().join("\n"), /new-session-output/u);
});

function shellState(transcript: MycliShellTranscriptBlock[]): MycliShellState {
	return { ...projectRuntimeState({
		...initialRuntimeState(), sessionId: "session", trustGateDismissed: true, trust: { state: "trusted" },
	}), transcript };
}

function shellBlocks(count: number): MycliShellTranscriptBlock[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `shell-${index}`, kind: "bash", bash: {
			id: `shell-${index}`, shellId: `shell-${index}`, callId: `call-${index}`,
			command: `command-${index}`, status: "success", outputPreview: `retained-output-${index}`,
		},
	}));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "condition did not settle");
		await setTimeout(10);
	}
}
