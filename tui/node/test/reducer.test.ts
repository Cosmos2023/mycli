import assert from "node:assert/strict";
import test from "node:test";
import { initialState, reduceShellState } from "../src/state/reducer.ts";

test("bootstrap adds welcome notice and status", () => {
  const state = reduceShellState(initialState(), {
    type: "bootstrap.result",
    payload: {
      session_id: "demo",
      workspace: "/repo",
      model: "deepseek-v4",
      provider: "deepseek/chat_completions",
      status: {
        context_window: { used_tokens: 10, max_tokens: 100, source: "provider" },
      },
      welcome: {
        version: "0.1.0",
        session_id: "demo",
        workspace: "/repo",
        model: "deepseek-v4",
        provider: "deepseek/chat_completions",
        context_window: { used_tokens: 10, max_tokens: 100, source: "provider" },
        startup_mark: { name: "default", text: "mycli" },
        tips: ["/help"],
        release_notes_hint: "Run /release-notes",
      },
    },
  });

  assert.equal(state.sessionId, "demo");
  assert.equal(state.transcript[0]?.type, "system_notice");
  assert.match(state.transcript[0]?.text ?? "", /mycli/);
});

test("turn events stream into one assistant item and finalize authoritatively", () => {
  let state = initialState();
  state = reduceShellState(state, { type: "user.submit", message: "hello" });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "turn.started",
    params: { client_turn_id: "c1" },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "turn.event",
    params: {
      client_turn_id: "c1",
      phase: "assistant_delta",
      kind: "text_delta",
      text: "hel",
    },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "turn.event",
    params: {
      client_turn_id: "c1",
      phase: "assistant_delta",
      kind: "text_delta",
      text: "lo",
    },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "turn.completed",
    params: {
      client_turn_id: "c1",
      assistant_message: "hello final",
      activity_events: [],
      progress_updates: [],
      plan_steps: [],
      pending_decision: false,
    },
  });

  assert.equal(state.turnRunning, false);
  assert.equal(state.transcript.at(-1)?.type, "assistant_final");
  assert.equal(state.transcript.at(-1)?.text, "hello final");
});

test("typed message deltas stream assistant text and suppress duplicate legacy deltas", () => {
  let state = initialState();
  state = reduceShellState(state, { type: "user.submit", message: "hello" });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "turn.started",
    params: { client_turn_id: "c1" },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "message.delta",
    params: { client_turn_id: "c1", text: "hel" },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "turn.event",
    params: {
      client_turn_id: "c1",
      phase: "assistant_delta",
      kind: "text_delta",
      text: "hel",
    },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "message.delta",
    params: { client_turn_id: "c1", text: "lo" },
  });

  const assistant = state.transcript.find((item) => item.type === "assistant_stream");
  assert.equal(assistant?.text, "hello");
});

test("runtime event envelope unwraps into existing reducer event handling", () => {
  let state = initialState();
  state = reduceShellState(state, { type: "user.submit", message: "hello" });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "runtime.event",
    params: {
      version: 1,
      sequence: 1,
      type: "message.delta",
      timestamp: 1770000000,
      payload: { client_turn_id: "c1", text: "hello" },
    },
  });

  const assistant = state.transcript.find((item) => item.type === "assistant_stream");
  assert.equal(assistant?.text, "hello");
  assert.equal(state.typedMessageTurnId, "c1");
});

test("legacy assistant turn events still stream when typed deltas are absent", () => {
  let state = initialState();
  state = reduceShellState(state, { type: "user.submit", message: "hello" });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "turn.started",
    params: { client_turn_id: "legacy_1" },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "turn.event",
    params: {
      client_turn_id: "legacy_1",
      phase: "assistant_delta",
      kind: "text_delta",
      text: "legacy",
    },
  });

  assert.equal(state.transcript.at(-1)?.type, "assistant_stream");
  assert.equal(state.transcript.at(-1)?.text, "legacy");
});

test("reasoning and thinking deltas update live reasoning without changing answer text", () => {
  let state = initialState();
  state = reduceShellState(state, { type: "user.submit", message: "hello" });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "message.delta",
    params: { client_turn_id: "c1", text: "answer" },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "reasoning.delta",
    params: { client_turn_id: "c1", text: "checking files" },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "thinking.delta",
    params: { client_turn_id: "c1", text: "reading tests" },
  });

  assert.equal(state.transcript.at(-1)?.type, "assistant_stream");
  assert.equal(state.transcript.at(-1)?.text, "answer");
  assert.equal(state.liveReasoning?.text, "reading tests");
  assert.equal(state.liveReasoning?.kind, "thinking");
});

test("command view mode updates local UI state", () => {
  const state = reduceShellState(initialState(), {
    type: "command.result",
    command: "/view verbose",
    result: { lines: ["[view] mode=verbose"], presentation: "transcript", view_mode: "verbose" },
  });

  assert.equal(state.viewMode, "verbose");
});

test("approval pending event stores prompt state", () => {
  const state = reduceShellState(initialState(), {
    type: "gateway.event",
    method: "approval.request",
    params: {
      decision_id: "decision_current",
      preview: "git push",
      options: [{ choice: "approve_once", label: "Allow once" }],
    },
  });

  assert.equal(state.pendingApproval?.decision_id, "decision_current");
});

test("status update tracks live turn state and clears resolved approval", () => {
  let state = initialState();
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "approval.request",
    params: {
      decision_id: "decision_current",
      preview: "git push",
      options: [{ choice: "reject", label: "Reject" }],
    },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "status.update",
    params: {
      client_turn_id: "c1",
      state: "waiting_approval",
      kind: "waiting_approval",
      text: "Waiting approval",
    },
  });

  assert.equal(state.pendingApproval?.decision_id, "decision_current");
  assert.equal(state.liveStatus?.state, "waiting_approval");
  assert.equal(state.turnRunning, true);

  state = reduceShellState(state, {
    type: "gateway.event",
    method: "approval.respond",
    params: { decision_id: "decision_current", choice: "reject" },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "status.update",
    params: {
      client_turn_id: "approval_c1",
      state: "completed",
      kind: "completed",
      text: "Completed",
    },
  });

  assert.equal(state.pendingApproval, null);
  assert.equal(state.liveStatus?.state, "completed");
  assert.equal(state.turnRunning, false);
});

test("tool lifecycle events update the active tool row without duplication", () => {
  let state = initialState();
  state = reduceShellState(state, { type: "user.submit", message: "read config" });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "turn.started",
    params: { client_turn_id: "c1" },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "tool.start",
    params: {
      client_turn_id: "c1",
      tool_id: "call_read_1",
      call_id: "call_read_1",
      name: "Read",
      context: "pyproject.toml",
      args_preview: "file_path=pyproject.toml",
    },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "tool.complete",
    params: {
      client_turn_id: "c1",
      tool_id: "call_read_1",
      call_id: "call_read_1",
      name: "Read",
      duration_s: 0.125,
      summary: "Read pyproject.toml",
      success: true,
    },
  });

  const tools = state.transcript.filter((item) => item.type === "tool_summary");
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.metadata.status, "done");
  assert.equal(tools[0]?.metadata.duration_s, 0.125);
  assert.equal(tools[0]?.metadata.tool_name, "Read");
});

test("tool failed event marks a matching tool row as failed", () => {
  let state = initialState();
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "tool.start",
    params: {
      client_turn_id: "c1",
      tool_id: "call_write_1",
      call_id: "call_write_1",
      name: "Write",
      context: "notes.txt",
    },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "tool.failed",
    params: {
      client_turn_id: "c1",
      tool_id: "call_write_1",
      call_id: "call_write_1",
      name: "Write",
      duration_s: 0.002,
      summary: "Tool Write could not run.",
      success: false,
      error: "Missing required arguments: content",
    },
  });

  const tool = state.transcript.find((item) => item.type === "tool_summary");
  assert.equal(tool?.metadata.status, "failed");
  assert.equal(tool?.metadata.error, "Missing required arguments: content");
});

test("overlay command result opens overlay instead of transcript row", () => {
  const state = reduceShellState(initialState(), {
    type: "command.result",
    command: "/usage",
    result: { lines: ["turns=1"], presentation: "overlay" },
  });

  assert.equal(state.overlay.visible, true);
  assert.equal(state.overlay.lines[0], "turns=1");
  assert.equal(state.transcript.length, 0);
});
