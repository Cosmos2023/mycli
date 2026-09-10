import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { gatewayToolLifecycleRecord, type GatewayTerminalInteraction } from "@mycli/contracts";
import {
	initialRuntimeState,
	type RuntimeShellState,
} from "../../../src/state/runtime-state-model.ts";
import {
	projectRuntimeState,
} from "../../../src/state/runtime-projection.ts";
import {
	reduceRuntimeEvent,
} from "../../../src/state/runtime-event-reducer.ts";
import {
	runtimeStateFromTranscript,
} from "../../../src/state/transcript-history.ts";
import { ToolExecutionComponent } from "../../../src/components/transcript/tool-execution.ts";
import {
	renderTranscriptBlocks,
} from "../../../src/components/transcript/transcript-renderer.ts";
import {
	MycliShellRuntime,
} from "../../../src/application/shell-runtime.ts";
import { visibleWidth } from "../../../src/tui-core/utils.ts";
import { HeadlessTerminal } from "../../support/headless-terminal.ts";

const INPUT: GatewayTerminalInteraction = { shell_id: "shell-1", kind: "input", input_preview: '"y\\n"' };
const POLL: GatewayTerminalInteraction = { shell_id: "shell-1", kind: "poll" };

test("terminal input without echo stays visible once alongside the original Shell", () => {
	let state = lifecycle(shellState(), "tool.start", "input-1", INPUT);
	assert.equal(projectRuntimeState(state).bash.length, 1);
	assert.match(rendered(state), /Interacting with background terminal.*node wait.cjs/u);
	state = lifecycle(state, "tool.complete", "input-1", { ...INPUT, interaction_succeeded: true, process_running: true });
	state = lifecycle(state, "tool.complete", "input-1", { ...INPUT, interaction_succeeded: true, process_running: true });
	const display = rendered(state);
	assert.equal((display.match(/Interacted with background terminal/gu) ?? []).length, 1);
	assert.match(display, /"y\\n"/u);
	assert.equal(projectRuntimeState(state).bash.length, 1);
	assert.doesNotMatch(display, /WriteStdin/u);
});

test("terminal waits follow their call ownership and only retain polls of live processes", () => {
	let state = lifecycle(shellState(), "tool.start", "poll-1", POLL);
	assert.equal(state.liveStatus?.text, "Waiting for background terminal");
	assert.equal(state.liveStatus?.message, "node wait.cjs");
	assert.equal(projectRuntimeState(state).tools.length, 0);
	state = reduceRuntimeEvent(state, "tool.complete", { call_id: "other", name: "Read", success: true });
	assert.equal(state.liveStatus?.callId, "poll-1");
	state = lifecycle(state, "tool.start", "poll-2", POLL);
	state = lifecycle(state, "tool.complete", "poll-2", { ...POLL, interaction_succeeded: true, process_running: true });
	assert.equal(state.liveStatus?.callId, "poll-1");
	assert.match(rendered(state), /Waited for background terminal/u);
	state = lifecycle(state, "tool.complete", "poll-1", { ...POLL, interaction_succeeded: true, process_running: false });
	assert.equal(state.liveStatus?.kind, "running");
	assert.equal(projectRuntimeState(state).tools.filter((tool) => tool.terminalInteraction).length, 1);
});

test("Ctrl+C remains an interaction when the process exits, while write failures stay visible", () => {
	let state = lifecycle(shellState(), "tool.start", "interrupt", { ...INPUT, input_preview: '"^C"' });
	state = lifecycle(state, "tool.failed", "interrupt", { ...INPUT, input_preview: '"^C"', interaction_succeeded: true, process_running: false });
	assert.match(rendered(state), /Interacted with background terminal/u);
	assert.match(rendered(state), /\^C/u);
	assert.doesNotMatch(rendered(state), /Terminal interaction failed/u);
	state = lifecycle(state, "tool.failed", "failed-input", { ...INPUT, interaction_succeeded: false });
	assert.match(rendered(state), /Terminal interaction failed/u);
});

test("terminal interaction history survives transcript reload and rejects old-session events", () => {
	const state = runtimeStateFromTranscript(initialRuntimeState(), { items: [{
		id: "history-input", type: "tool_summary", text: "Shell is running",
		metadata: { tool_name: "WriteStdin", success: true, terminal_interaction: {
			...INPUT, command_preview: "node wait.cjs", interaction_succeeded: true, process_running: true,
		} },
	}] });
	assert.match(rendered(state), /Interacted with background terminal.*node wait.cjs/u);
	const changed = reduceRuntimeEvent({ ...state, sessionId: "new-session", sessionGeneration: 2 }, "tool.start", {
		session_id: "old-session", generation: 1, call_id: "old-poll", name: "WriteStdin", terminal_interaction: POLL,
	});
	assert.equal(changed.liveStatus, state.liveStatus);
	assert.equal(changed.transcript, state.transcript);
	const waiting = lifecycle(shellState(), "tool.start", "cancel-poll", POLL);
	const interrupted = reduceRuntimeEvent(waiting, "turn.completed", { turn_id: "turn-1", turn_state: "interrupted" });
	assert.equal(interrupted.liveStatus?.kind, "interrupted");
	assert.doesNotMatch(rendered(interrupted), /Waiting for background terminal/u);
	assert.match(rendered(interrupted), /Terminal interaction interrupted/u);
});

test("terminal interaction rendering fits narrow terminals and sanitizes terminal controls", () => {
	const component = new ToolExecutionComponent({ id: "input", name: "WriteStdin", status: "success",
		terminalInteraction: { ...INPUT, input_preview: '"long input\\n"'.repeat(20),
			command_preview: "node scripts/very-long-interactive-command.cjs\u001b[2J", interaction_succeeded: true } });
	for (const width of [20, 40, 80, 160]) {
		const lines = component.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.ok(!lines.join("\n").includes("\u001b[2J"));
		assert.match(stripVTControlCharacters(lines.join("\n")), /Interacted/u);
	}
});

for (const nativeScrollback of [false, true]) {
	test(`terminal frames update interactions and waits without stale rows (native=${nativeScrollback})`, async (t) => {
		const terminal = new HeadlessTerminal({ columns: 80, rows: 30, nativeScrollback });
		let state = shellState();
		const runtime = new MycliShellRuntime({ initialState: projectRuntimeState(state), terminal });
		t.after(async () => { await runtime.shutdown(); await terminal.flush(); terminal.dispose(); });
		runtime.start();
		const frame = async (): Promise<string> => {
			runtime.setState(projectRuntimeState(state));
			await delay(40);
			await terminal.flush();
			return terminal.bufferLines().join("\n");
		};
		state = lifecycle(state, "tool.start", "input-1", INPUT);
		assert.match(await frame(), /Interacting with background terminal/u);
		state = lifecycle(state, "tool.complete", "input-1", { ...INPUT, interaction_succeeded: true, process_running: true });
		const interacted = await frame();
		assert.match(interacted, /Interacted with background terminal/u);
		assert.doesNotMatch(interacted, /Interacting with background terminal/u);
		state = lifecycle(state, "tool.start", "poll-1", POLL);
		assert.match(await frame(), /Waiting for background terminal/u);
		state = lifecycle(state, "tool.complete", "poll-1", { ...POLL, interaction_succeeded: true, process_running: true });
		assert.match(await frame(), /Waited for background terminal/u);
		state = lifecycle(state, "tool.start", "poll-ended", POLL);
		await frame();
		state = lifecycle(state, "tool.complete", "poll-ended", { ...POLL, interaction_succeeded: true, process_running: false });
		for (const width of [40, 80, 120]) {
			terminal.resize(width, 30);
			await delay(120);
			const display = await frame();
			assert.equal((display.match(/Interacted with background terminal/gu) ?? []).length, 1);
			assert.equal((display.match(/Waited for background terminal/gu) ?? []).length, 1);
			assert.doesNotMatch(display, /Waiting for background terminal/u);
		}
	});
}

function shellState(): RuntimeShellState {
	const state = reduceRuntimeEvent(initialRuntimeState(), "turn.started", { turn_id: "turn-1" });
	return reduceRuntimeEvent(state, "shell.started", { shell_id: "shell-1", call_id: "shell-call", sequence: 1,
		command_preview: "node wait.cjs", background: true, process_state: "running_background" });
}

function lifecycle(state: RuntimeShellState, method: "tool.start" | "tool.complete" | "tool.failed",
	callId: string, interaction: GatewayTerminalInteraction): RuntimeShellState {
	const params = { call_id: callId, tool_id: callId, name: "WriteStdin", terminal_interaction: interaction,
		...(method !== "tool.start" ? { success: method === "tool.complete" } : {}) };
	return reduceRuntimeEvent(state, method, { ...params, tool_record: gatewayToolLifecycleRecord(method, params) });
}

function rendered(state: RuntimeShellState): string {
	return stripVTControlCharacters(renderTranscriptBlocks(projectRuntimeState(state).transcript ?? [], 120).join("\n"));
}
