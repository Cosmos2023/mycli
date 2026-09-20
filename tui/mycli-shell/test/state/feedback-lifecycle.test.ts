import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { renderMycliShell } from "../../src/index.ts";
import { MycliShellRuntime } from "../../src/application/shell-runtime.ts";
import { NoticeMessageComponent } from "../../src/components/transcript/notice-message.ts";
import { runtimeStateWithResources } from "../../src/state/extension-feedback.ts";
import { reduceRuntimeEvent } from "../../src/state/runtime-event-reducer.ts";
import { projectRuntimeState } from "../../src/state/runtime-projection.ts";
import { initialRuntimeState } from "../../src/state/runtime-state-model.ts";
import { HeadlessTerminal } from "../support/headless-terminal.ts";

test("repeated compactions keep separate results and late events cannot reopen them", () => {
	let state = reduceRuntimeEvent(initialRuntimeState(), "turn.started", { client_turn_id: "c", turn_id: "t" });
	const params = { client_turn_id: "c", source: "mid_turn", before_tokens: 900, after_tokens: 300, max_tokens: 1000, duration_s: 2 };
	for (const checkpoint_id of ["first", "second"]) {
		state = reduceRuntimeEvent(state, "compaction.started", { ...params, checkpoint_id });
		state = reduceRuntimeEvent(state, "compaction.completed", { ...params, checkpoint_id, status: "compressed" });
	}
	assert.equal(state.transcript.length, 2);
	assert.equal(state.activeCompaction, null);
	state = reduceRuntimeEvent(state, "compaction.started", { ...params, checkpoint_id: "first" });
	assert.equal(state.activeCompaction, null);
	state = reduceRuntimeEvent(state, "compaction.started", { ...params, checkpoint_id: "third" });
	state = reduceRuntimeEvent(state, "compaction.completed", { ...params, checkpoint_id: "first", status: "compressed" });
	assert.equal(state.activeCompaction?.id, "third");
	assert.equal(state.turnRunning, true);
});

test("manual compaction is cancellable work without becoming a user turn or a failure", () => {
	const params = { checkpoint_id: "manual", client_turn_id: "manual", source: "user_requested", before_tokens: 900, max_tokens: 1000 };
	let state = reduceRuntimeEvent(initialRuntimeState(), "compaction.started", params);
	assert.equal(state.turnRunning, false);
	assert.equal(projectRuntimeState(state).footer.operationRunning, true);
	state = reduceRuntimeEvent(state, "compaction.completed", { ...params, status: "interrupted", after_tokens: 900, duration_s: 1 });
	assert.equal(state.turnRunning, false);
	assert.equal(state.activeCompaction, null);
	const output = plain(renderMycliShell(projectRuntimeState(state), 120).join("\n"));
	assert.match(output, /Cancelled/);
	assert.doesNotMatch(output, /failed|Worked|Turn interrupted/);
});

test("compaction has its own clock and returns to the original turn clock", async (t) => {
	let now = 1000;
	const terminal = new HeadlessTerminal();
	const runtime = new MycliShellRuntime({ terminal, now: () => now, initialState: {
		messages: [], tools: [], bash: [], footer: { cwd: "/workspace", turnRunning: true, liveState: "Working" }, settings: { reducedMotion: true },
	} });
	t.after(async () => { await runtime.shutdown(); terminal.dispose(); });
	now = 61000;
	runtime.setState({ ...runtime.getState(), footer: { ...runtime.getState().footer, liveState: "Compacting context", liveStateKind: "compaction", liveOperationId: "one" } });
	assert.match(plain(runtime.statusContainer.render(120).join("\n")), /Compacting context \(0s/);
	now = 64000;
	runtime.setState({ ...runtime.getState(), footer: { ...runtime.getState().footer, liveState: "Working", liveStateKind: "running", liveOperationId: undefined } });
	assert.match(plain(runtime.statusContainer.render(120).join("\n")), /1m 03s/);
});

test("approval responses retain their scope once, and ignore unmatched responses", () => {
	for (const [choice, expected] of [
		["approve_once", "You approved mycli to run git status this time"],
		["allow_session", "You approved mycli to run git status every time this session"],
		["always_allow", "You approved mycli to always run commands that start with git status"],
		["reject", "You did not approve mycli to run git status"],
	]) {
		let state = reduceRuntimeEvent(initialRuntimeState(), "approval.request", { decision_id: "d", command_preview: "git status", preview: "Shell", tool_name: "Shell" });
		assert.equal(reduceRuntimeEvent(state, "approval.respond", { decision_id: "other", choice }), state);
		state = reduceRuntimeEvent(state, "approval.respond", { decision_id: "d", choice });
		state = reduceRuntimeEvent(state, "approval.respond", { decision_id: "d", choice });
		assert.equal(state.pendingApproval, null);
		assert.equal(state.transcript.length, 1);
		assert.equal(state.transcript[0]?.text, expected);
	}
});

test("approval decisions shorten long or multi-line commands to a snippet", () => {
	const long = `Get-ChildItem ${"x".repeat(200)}`;
	let state = reduceRuntimeEvent(initialRuntimeState(), "approval.request", { decision_id: "long", command_preview: long, tool_name: "Shell" });
	state = reduceRuntimeEvent(state, "approval.respond", { decision_id: "long", choice: "approve_once" });
	const longText = String(state.transcript[0]?.text ?? "");
	assert.match(longText, /^You approved mycli to run Get-ChildItem /u);
	assert.match(longText, /… this time$/u);
	assert.equal(longText.includes("x".repeat(100)), false);

	let multiline = reduceRuntimeEvent(initialRuntimeState(), "approval.request", {
		decision_id: "multi",
		command_preview: "$PSVersionTable.PSVersion;\nWrite-Output done",
		tool_name: "Shell",
	});
	multiline = reduceRuntimeEvent(multiline, "approval.respond", { decision_id: "multi", choice: "approve_once" });
	assert.equal(multiline.transcript[0]?.text,
		"You approved mycli to run $PSVersionTable.PSVersion; ... this time");
});

test("MCP startup uses catalog state and failures are deduplicated across refreshes", () => {
	const loading = { id: "mcp:web", type: "mcp" as const, name: "web", enabled: true, status: "loading" };
	let state = runtimeStateWithResources(initialRuntimeState(), [loading]);
	assert.match(projectRuntimeState(state).footer.extensionStatuses?.[0] ?? "", /Starting MCP servers 0\/1.*web/);
	const failed = { ...loading, status: "failed", detail: "0 tools; connection_error" };
	state = runtimeStateWithResources(state, [failed]);
	state = runtimeStateWithResources(state, [failed]);
	assert.equal(state.transcript.length, 1);
	assert.match(state.transcript[0]!.text, /MCP web could not start.*\/mcp/);
	assert.deepEqual(projectRuntimeState(state).footer.extensionStatuses, []);
	state = runtimeStateWithResources(state, [{ ...loading, status: "ready" }]);
	state = runtimeStateWithResources(state, [failed]);
	assert.equal(state.transcript.length, 2);
});

test("Hook completion clears only its own activity and records a safe failure once", () => {
	let state = reduceRuntimeEvent(initialRuntimeState(), "turn.started", { turn_id: "t" });
	for (const operation_id of ["a", "b"]) state = reduceRuntimeEvent(state, "hook.started", { turn_id: "t", operation_id, point: "stop" });
	assert.match(projectRuntimeState(state).footer.liveState ?? "", /Running stop hooks/);
	const failure = { turn_id: "t", operation_id: "a", point: "stop", status: "failed", message: "Hook timed out" };
	state = reduceRuntimeEvent(state, "hook.completed", failure);
	state = reduceRuntimeEvent(state, "hook.completed", failure);
	assert.deepEqual(Object.keys(state.activeHooks), ["b"]);
	assert.equal(state.transcript.length, 1);
	state = reduceRuntimeEvent(state, "turn.completed", { turn_id: "t", turn_state: "completed" });
	assert.deepEqual(state.activeHooks, {});
});

test("Goal budget stops have specific guidance and do not show a generic interrupt", () => {
	const state = reduceRuntimeEvent(initialRuntimeState(), "turn.interrupted", { turn_id: "t", interruption_reason: "goal_budget" });
	assert.match(state.transcript[0]!.text, /Goal token budget reached.*\/goal budget/);
	assert.doesNotMatch(state.transcript[0]!.text, /send a new message/);
});

test("informational notices and failures have distinct glyphs", () => {
	for (const [role, glyph] of [["system", "•"], ["warning", "⚠"], ["error", "✖"]] as const) {
		const text = plain(new NoticeMessageComponent({ id: role, role, text: "Feedback" }).render(80).join("\n"));
		if (role === "error") assert.doesNotMatch(text, /• Feedback/);
		else assert.ok(text.includes(glyph));
	}
});

test("Ctrl+C exit hint expires and input clears it without transcript messages", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const terminal = new HeadlessTerminal();
	const runtime = new MycliShellRuntime({ terminal, initialState: {
		messages: [], tools: [], bash: [], footer: { cwd: "/workspace", turnRunning: false }, settings: { statusbarMode: "off", reducedMotion: true },
	} });
	t.after(() => { runtime.stop(); terminal.dispose(); });
	runtime.start();
	terminal.sendInput("\x03");
	assert.match(plain(runtime.footerContainer.render(80).join("\n")), /Press Ctrl\+C again/);
	assert.equal(runtime.getState().messages.length, 0);
	t.mock.timers.tick(2000);
	assert.doesNotMatch(plain(runtime.footerContainer.render(80).join("\n")), /Press Ctrl\+C again/);
	terminal.sendInput("\x03");
	runtime.editor.setText("new input");
	assert.doesNotMatch(plain(runtime.footerContainer.render(80).join("\n")), /Press Ctrl\+C again/);
	assert.equal(runtime.getState().messages.length, 0);
});

test("live terminal attention respects decision panel focus, session replacement, and runtime stop", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const terminal = new HeadlessTerminal();
	let state = reduceRuntimeEvent({ ...initialRuntimeState(), sessionId: "session-a" }, "turn.started", { turn_id: "turn-a" });
	const runtime = new MycliShellRuntime({ terminal, initialState: projectRuntimeState(state) });
	t.after(() => { runtime.stop(); terminal.dispose(); });
	const notifications = (): string[] => terminal.writes.filter((value) => value.startsWith("\x1b]9;mycli:"));
	runtime.start();
	terminal.sendInput("\x1b[O");
	state = reduceRuntimeEvent(state, "turn.completed", { turn_id: "turn-a", turn_state: "completed" });
	runtime.setState(projectRuntimeState(state), { eventType: "turn.completed" });
	t.mock.timers.tick(200);
	assert.deepEqual(notifications(), ["\x1b]9;mycli: Turn completed\x07"]);
	runtime.setState(projectRuntimeState(state), { eventType: "turn.completed" });
	t.mock.timers.tick(200);
	assert.equal(notifications().length, 1);

	state = reduceRuntimeEvent(state, "approval.request", { decision_id: "approval-a", tool_name: "Shell", preview: "synthetic private subject" });
	runtime.setState(projectRuntimeState(state), { eventType: "approval.request" });
	assert.match(plain(runtime.editorContainer.render(80).join("\n")), /Permission required/);
	terminal.sendInput("\x1b[I");
	t.mock.timers.tick(200);
	assert.equal(notifications().length, 1);

	terminal.sendInput("\x1b[O");
	state = reduceRuntimeEvent(state, "approval.request", { decision_id: "approval-b", tool_name: "Shell", preview: "synthetic private subject" });
	runtime.setState(projectRuntimeState(state), { eventType: "approval.request" });
	runtime.replaceSessionState(projectRuntimeState({ ...initialRuntimeState(), sessionId: "session-b" }));
	t.mock.timers.tick(200);
	assert.equal(notifications().length, 1);

	state = reduceRuntimeEvent({ ...initialRuntimeState(), sessionId: "session-b" }, "approval.request", { decision_id: "approval-c", tool_name: "Shell", preview: "synthetic private subject" });
	runtime.setState(projectRuntimeState(state), { eventType: "approval.request" });
	runtime.stop();
	t.mock.timers.tick(200);
	assert.equal(notifications().length, 1);
});
