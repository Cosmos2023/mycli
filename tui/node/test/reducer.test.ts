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

test("turn events stream into one assistant item and finalize from message complete", () => {
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
      assistant_message: "legacy final should not win",
      activity_events: [],
      progress_updates: [],
      plan_steps: [],
      pending_decision: false,
      turn_state: "completed",
    },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "message.complete",
    params: {
      client_turn_id: "c1",
      text: "hello final",
      final: true,
      source: "turn_response",
    },
  });

  assert.equal(state.turnRunning, false);
  assert.equal(state.transcript.at(-1)?.type, "assistant_final");
  assert.equal(state.transcript.at(-1)?.text, "hello final");
});

test("stream metadata message complete does not finalize assistant text", () => {
  let state = initialState();
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "turn.event",
    params: {
      client_turn_id: "c1",
      phase: "assistant_delta",
      kind: "text_delta",
      text: "draft",
    },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "message.complete",
    params: { client_turn_id: "c1", response_status: "completed" },
  });

  assert.equal(state.transcript.at(-1)?.type, "assistant_stream");
  assert.equal(state.transcript.at(-1)?.text, "draft");
});

test("turn completed without final message complete does not append blank assistant row", () => {
  let state = initialState();
  state = reduceShellState(state, { type: "user.submit", message: "push" });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "approval.request",
    params: {
      decision_id: "decision_current",
      preview: "git push",
      options: [{ choice: "approve_once", label: "Allow once" }],
    },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "turn.completed",
    params: {
      client_turn_id: "c1",
      assistant_message: "",
      pending_decision: true,
      turn_state: "waiting_approval",
    },
  });

  assert.equal(state.pendingApproval?.decision_id, "decision_current");
  assert.equal(state.transcript.at(-1)?.type, "approval");
  assert.equal(
    state.transcript.some((item) => item.type === "assistant_final" && item.text === ""),
    false,
  );
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
