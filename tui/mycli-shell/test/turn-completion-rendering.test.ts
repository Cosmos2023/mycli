import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { turnCompletedDurationId } from "@mycli/contracts";
import {
	initialRuntimeState,
} from "../src/state/runtime-state-model.ts";
import {
	projectRuntimeState,
} from "../src/state/runtime-projection.ts";
import {
	reduceRuntimeEvent,
} from "../src/state/runtime-event-reducer.ts";
import {
	runtimeStateFromTranscript,
} from "../src/state/transcript-history.ts";
import type { RuntimeShellState } from "../src/state/runtime-state-model.ts";
import { completionDurationText } from "../src/components/transcript/turn-completed.ts";
import {
	MycliShellRuntime,
} from "../src/application/shell-runtime.ts";
import { HeadlessTerminal } from "./support/headless-terminal.ts";

class TranscriptTerminal extends HeadlessTerminal {
	override alternateScreen = false;
	private normalNativeScrollback = false;

	// Mirror ProcessTerminal so opening the viewer cannot enter ordinary scrollback.
	enterAlternateScreen(): void {
		if (this.alternateScreen) return;
		this.normalNativeScrollback = this.nativeScrollback;
		this.write("\x1b[?1049h");
		this.alternateScreen = true;
		this.nativeScrollback = false;
	}

	leaveAlternateScreen(): void {
		if (!this.alternateScreen) return;
		this.write("\x1b[?1049l");
		this.alternateScreen = false;
		this.nativeScrollback = this.normalNativeScrollback;
	}
}

function startTurn(state: RuntimeShellState, turnId: string): RuntimeShellState {
	return reduceRuntimeEvent(state, "turn.started", { turn_id: turnId });
}

function completeTurn(state: RuntimeShellState, turnId: string, durationMs?: number): RuntimeShellState {
	const answered = reduceRuntimeEvent(state, "message.complete", {
		turn_id: turnId, final: true, text: `Answer for ${turnId}.`,
	});
	return reduceRuntimeEvent(answered, "turn.completed", {
		turn_id: turnId, turn_state: "completed",
		...(durationMs === undefined ? {} : { duration_ms: durationMs }),
	});
}

function completionRows(lines: string[]): string[] {
	return lines.map((line) => stripVTControlCharacters(line).trim())
		.filter((line) => /(?:Worked for|Finished in|Completed in|Took) \d/u.test(line));
}

function setup(t: TestContext, nativeScrollback: boolean): {
	runtime: MycliShellRuntime;
	terminal: HeadlessTerminal;
	commands: string[];
	interrupts: string[];
	press: (key: string) => Promise<void>;
	frame: () => Promise<void>;
	assertCompletions: (...expected: string[]) => void;
} {
	const terminal = new TranscriptTerminal({ columns: 100, rows: 32, nativeScrollback });
	const commands: string[] = [];
	const interrupts: string[] = [];
	let now = 10_000;
	const runtime = new MycliShellRuntime({
		initialState: projectRuntimeState({ ...initialRuntimeState(), sessionId: "session-a" }),
		terminal,
		now: () => now,
		onCommandSubmit: (command) => { commands.push(command); throw new Error("Synthetic mode save failure"); },
		onInterrupt: () => { interrupts.push("interrupt"); },
	});
	t.after(async () => { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); });
	runtime.start();
	const frame = async (): Promise<void> => {
		await delay(35);
		await terminal.flush();
	};
	return {
		runtime, terminal, commands, interrupts, frame,
		press: async (key) => {
			now += 3_000;
			terminal.sendInput(key);
			await frame();
		},
		assertCompletions: (...expected) => {
			assert.deepEqual(completionRows(runtime.chatContainer.render(terminal.columns)), expected);
			assert.deepEqual(completionRows(terminal.bufferLines()), expected);
		},
	};
}

for (const nativeScrollback of [false, true]) {
	test(`completed turn stays singular through notices, keys, and resize (native=${nativeScrollback})`, async (t) => {
		const probe = setup(t, nativeScrollback);
		const running = startTurn({ ...initialRuntimeState(), sessionId: "session-a" }, "turn-a");
		probe.runtime.setState(projectRuntimeState(running));
		const completed = completeTurn(running, "turn-a", 12_000);
		probe.runtime.setState(projectRuntimeState(completed));
		await probe.frame();
		const expected = completionDurationText(12_000, turnCompletedDurationId("turn-a"));
		probe.assertCompletions(expected);

		for (const key of ["\x03", "\x0f", "\x1b", "a", "\x03", "\x1b[Z", "\x03", "\x14", "\x14"]) {
			await probe.press(key);
			if (!probe.runtime.ui.hasOverlay()) probe.assertCompletions(expected);
		}
		assert.equal(probe.runtime.getState().footer.turnRunning, false);
		assert.deepEqual(probe.interrupts, []);
		assert.deepEqual(probe.commands, ["/mode plan"]);
		assert.ok(probe.runtime.getState().messages.some((message) => message.text === "Press Ctrl+C again to exit."));
		assert.ok(probe.runtime.getState().messages.some((message) => message.text.includes("Synthetic mode save failure")));
		assert.equal(probe.runtime.getState().transcript?.filter((block) => block.kind === "turn_completed").length, 1);
		for (const width of [60, 100]) {
			probe.terminal.resize(width, 32);
			await delay(120);
			await probe.terminal.flush();
			probe.assertCompletions(expected);
		}
	});

	for (const scenario of ["missing duration", "status only"] as const) {
		test(`completion is not fabricated from ${scenario} (native=${nativeScrollback})`, async (t) => {
			const probe = setup(t, nativeScrollback);
			const running = startTurn({ ...initialRuntimeState(), sessionId: "session-a" }, "turn-a");
			probe.runtime.setState(projectRuntimeState(running));
			const completed = scenario === "missing duration"
				? completeTurn(running, "turn-a")
				: reduceRuntimeEvent(running, "turn.status", {
					turn_id: "turn-a", state: "completed", kind: "completed", text: "Completed", duration_ms: 12_000,
				});
			probe.runtime.setState(projectRuntimeState(completed));
			await probe.frame();
			probe.assertCompletions();
			await probe.press("\x03");
			probe.runtime.setState({ ...probe.runtime.getState(), settings: { reducedMotion: true } });
			await probe.frame();
			probe.assertCompletions();
		});
	}

	test(`turn events deduplicate and interruption cannot add a completion (native=${nativeScrollback})`, async (t) => {
		const probe = setup(t, nativeScrollback);
		let state: RuntimeShellState = { ...initialRuntimeState(), sessionId: "session-a" };
		const expected: string[] = [];
		for (const [turnId, durationMs] of [["turn-a", 12_000], ["turn-b", 4_000]] as const) {
			state = startTurn(state, turnId);
			probe.runtime.setState(projectRuntimeState(state));
			state = completeTurn(state, turnId, durationMs);
			probe.runtime.setState(projectRuntimeState(state));
			state = reduceRuntimeEvent(state, "turn.completed", {
				turn_id: turnId, turn_state: "completed", duration_ms: durationMs,
			});
			state = reduceRuntimeEvent(state, "turn.status", {
				state: "completed", kind: "completed", text: "Completed",
			});
			probe.runtime.setState(projectRuntimeState(state));
			expected.push(completionDurationText(durationMs, turnCompletedDurationId(turnId)));
			await probe.frame();
			probe.assertCompletions(...expected);
		}
		state = startTurn(state, "turn-c");
		probe.runtime.setState(projectRuntimeState(state));
		await probe.press("\x03");
		state = reduceRuntimeEvent(state, "turn.interrupted", { turn_id: "turn-c", requested: true });
		probe.runtime.setState(projectRuntimeState(state));
		await probe.press("\x1b");
		state = reduceRuntimeEvent(state, "turn.interrupted", { turn_id: "turn-c", requested: false });
		probe.runtime.setState(projectRuntimeState(state));
		await probe.frame();
		assert.deepEqual(probe.interrupts, ["interrupt", "interrupt"]);
		assert.equal(state.liveStatus?.state, "interrupted");
		probe.assertCompletions(...expected);
	});

	test(`session replay owns its duration after local prompts (native=${nativeScrollback})`, async (t) => {
		const probe = setup(t, nativeScrollback);
		const first = startTurn({ ...initialRuntimeState(), sessionId: "session-a" }, "turn-a");
		probe.runtime.setState(projectRuntimeState(first));
		probe.runtime.setState(projectRuntimeState(completeTurn(first, "turn-a", 12_000)));
		await probe.frame();
		const other = completeTurn(startTurn({ ...initialRuntimeState(), sessionId: "session-b" }, "turn-b"), "turn-b", 4_000);
		const replayed = runtimeStateFromTranscript({ ...initialRuntimeState(), sessionId: "session-b" }, {
			items: other.transcript, next_before: null,
		});
		const refreshed = reduceRuntimeEvent(replayed, "status.update", {
			state: "completed", kind: "completed", text: "Completed", duration_ms: 4_000,
		});
		probe.runtime.replaceSessionState(projectRuntimeState(refreshed));
		await probe.frame();
		await probe.press("\x03");
		probe.assertCompletions(completionDurationText(4_000, turnCompletedDurationId("turn-b")));
		assert.equal(probe.runtime.getState().sessionId, "session-b");
		assert.equal(probe.runtime.getState().footer.liveState, "Completed");
	});
}
