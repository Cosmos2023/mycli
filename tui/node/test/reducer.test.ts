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

test("command view mode updates local UI state", () => {
  const state = reduceShellState(initialState(), {
    type: "command.result",
    command: "/view verbose",
    result: { lines: ["[view] mode=verbose"], presentation: "transcript", view_mode: "verbose" },
  });

  assert.equal(state.viewMode, "verbose");
});
