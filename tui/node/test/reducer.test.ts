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
    method: "message.delta",
    params: {
      client_turn_id: "c1",
      text: "hel",
    },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "message.delta",
    params: {
      client_turn_id: "c1",
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
  assert.equal(state.liveStatus?.kind, "thinking");
  assert.equal(state.liveStatus?.text, "Thinking: reading tests");
});

test("message complete annotates active stream metadata without finalizing the answer", () => {
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
    params: { client_turn_id: "c1", text: "draft" },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "thinking.delta",
    params: { client_turn_id: "c1", text: "finishing" },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "message.complete",
    params: {
      client_turn_id: "c1",
      response_status: "completed",
      request_id: "req_1",
      nested: { ignored: true },
    },
  });

  const assistant = state.transcript.at(-1);
  assert.equal(state.turnRunning, true);
  assert.equal(state.liveReasoning, null);
  assert.equal(assistant?.type, "assistant_stream");
  assert.equal(assistant?.text, "draft");
  assert.deepEqual(assistant?.metadata.message_complete, {
    client_turn_id: "c1",
    response_status: "completed",
    request_id: "req_1",
  });

  state = reduceShellState(state, {
    type: "gateway.event",
    method: "message.complete",
    params: { client_turn_id: "c1", text: "final answer", final: true },
  });

  assert.equal(state.turnRunning, false);
  assert.equal(state.transcript.at(-1)?.type, "assistant_final");
  assert.equal(state.transcript.at(-1)?.text, "final answer");
  assert.deepEqual(state.transcript.at(-1)?.metadata, {});
});

test("runtime event envelope can carry message complete into reducer state", () => {
  let state = initialState();
  state = reduceShellState(state, { type: "user.submit", message: "hello" });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "message.delta",
    params: { client_turn_id: "c1", text: "answer" },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "runtime.event",
    params: {
      version: 1,
      sequence: 2,
      type: "message.complete",
      timestamp: 1770000001,
      payload: { client_turn_id: "c1", response_status: "completed" },
    },
  });

  assert.deepEqual(state.transcript.at(-1)?.metadata.message_complete, {
    client_turn_id: "c1",
    response_status: "completed",
  });
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

test("approval response event preserves canonical decision choices", () => {
  let state = reduceShellState(initialState(), {
    type: "gateway.event",
    method: "approval.request",
    params: {
      decision_id: "decision_current",
      preview: "git push",
      options: [{ choice: "allow_session", label: "Allow for session" }],
    },
  });

  assert.equal(state.pendingApproval?.options[0]?.choice, "allow_session");

  state = reduceShellState(state, {
    type: "gateway.event",
    method: "approval.respond",
    params: { decision_id: "decision_current", choice: "allow_session" },
  });

  assert.equal(state.pendingApproval, null);
});

test("clarify request stores pending state and appends transcript row", () => {
  let state = initialState();
  state = reduceShellState(state, { type: "user.submit", message: "choose scope" });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "clarify.request",
    params: {
      client_turn_id: "c1",
      request_id: "call_question_1",
      tool_id: "call_question_1",
      call_id: "call_question_1",
      tool_name: "AskUserQuestion",
      question: "Which slice should come next?",
      options: [
        { label: "Runtime", description: "Only runtime contract" },
        { label: "TUI", description: "Render the request" },
      ],
      header: "Scope",
      multi_select: false,
    },
  });

  assert.equal(state.pendingClarification?.request_id, "call_question_1");
  const clarification = state.transcript.at(-1);
  assert.equal(clarification?.type, "clarification");
  assert.equal(clarification?.text, "Which slice should come next?");
  assert.equal(clarification?.metadata.header, "Scope");
});

test("runtime event envelope can carry clarify request into reducer state", () => {
  let state = initialState();
  state = reduceShellState(state, { type: "user.submit", message: "choose scope" });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "runtime.event",
    params: {
      version: 1,
      sequence: 4,
      type: "clarify.request",
      timestamp: 1770000001,
      payload: {
        client_turn_id: "c1",
        request_id: "call_question_1",
        tool_id: "call_question_1",
        call_id: "call_question_1",
        tool_name: "AskUserQuestion",
        question: "Pick a path",
        options: [{ label: "Runtime" }, { label: "TUI" }],
        multi_select: false,
      },
    },
  });

  assert.equal(state.pendingClarification?.request_id, "call_question_1");
  assert.equal(state.transcript.at(-1)?.type, "clarification");
  assert.equal(state.transcript.at(-1)?.text, "Pick a path");
});

test("clarify response clears pending clarification", () => {
  let state = initialState();
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "clarify.request",
    params: {
      request_id: "call_question_1",
      tool_id: "call_question_1",
      call_id: "call_question_1",
      tool_name: "AskUserQuestion",
      question: "Pick a path",
      options: [{ label: "Runtime" }, { label: "TUI" }],
      multi_select: false,
    },
  });

  state = reduceShellState(state, {
    type: "gateway.event",
    method: "clarify.respond",
    params: { request_id: "call_question_1", response: "Runtime" },
  });

  assert.equal(state.pendingClarification, null);
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
  assert.equal(state.pendingClarification, null);
  assert.equal(state.liveStatus?.state, "completed");
  assert.equal(state.turnRunning, false);
});

test("status changed snapshot clears stale pending state after session resume", () => {
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
    method: "clarify.request",
    params: {
      request_id: "question_1",
      tool_id: "question_1",
      call_id: "question_1",
      tool_name: "AskUserQuestion",
      question: "Which branch?",
      options: [{ label: "main" }],
      multi_select: false,
    },
  });

  state = reduceShellState(state, {
    type: "gateway.event",
    method: "status.changed",
    params: {
      session_id: "resumed-tip",
      pending_decision: false,
      suspended_turn: false,
    },
  });

  assert.equal(state.pendingApproval, null);
  assert.equal(state.pendingClarification, null);
  assert.equal(state.status.session_id, "resumed-tip");
});

test("turn status tracks waiting approval without appending transcript rows", () => {
  let state = initialState();
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "approval.request",
    params: {
      decision_id: "decision_current",
      preview: "git push",
      options: [{ choice: "approve_once", label: "Allow once" }],
    },
  });
  const transcriptLength = state.transcript.length;

  state = reduceShellState(state, {
    type: "gateway.event",
    method: "turn.status",
    params: {
      client_turn_id: "c1",
      state: "waiting_approval",
      kind: "waiting_approval",
      text: "Waiting approval",
      terminal: false,
    },
  });

  assert.equal(state.pendingApproval?.decision_id, "decision_current");
  assert.equal(state.liveStatus?.state, "waiting_approval");
  assert.equal(state.turnRunning, true);
  assert.equal(state.currentTurnId, "c1");
  assert.equal(state.transcript.length, transcriptLength);
});

test("terminal turn status clears live turn bookkeeping without transcript output", () => {
  let state = initialState();
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "turn.started",
    params: { client_turn_id: "c1" },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "message.delta",
    params: { client_turn_id: "c1", text: "draft" },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "reasoning.delta",
    params: { client_turn_id: "c1", text: "thinking" },
  });
  const transcriptLength = state.transcript.length;

  state = reduceShellState(state, {
    type: "gateway.event",
    method: "turn.status",
    params: {
      client_turn_id: "c1",
      state: "interrupted",
      kind: "interrupted",
      text: "Interrupted",
      terminal: true,
      message: "Interrupt requested",
    },
  });

  assert.equal(state.turnRunning, false);
  assert.equal(state.currentTurnId, null);
  assert.equal(state.liveStatus?.state, "interrupted");
  assert.equal(state.liveStatus?.message, "Interrupt requested");
  assert.equal(state.liveReasoning, null);
  assert.equal(state.typedMessageTurnId, null);
  assert.equal(state.pendingApproval, null);
  assert.equal(state.pendingClarification, null);
  assert.equal(state.transcript.length, transcriptLength);
});

test("rejected turn status is terminal and clears pending approval", () => {
  let state = initialState();
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "turn.started",
    params: { client_turn_id: "c1" },
  });
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "approval.request",
    params: {
      client_turn_id: "c1",
      decision_id: "decision_current",
      preview: "git push",
      options: [{ choice: "reject", label: "Reject" }],
    },
  });
  const transcriptLength = state.transcript.length;

  state = reduceShellState(state, {
    type: "gateway.event",
    method: "turn.status",
    params: {
      client_turn_id: "c1",
      state: "rejected",
      kind: "rejected",
      text: "Rejected",
      terminal: true,
      message: "Rejected Bash. Pending decision cleared.",
    },
  });

  assert.equal(state.turnRunning, false);
  assert.equal(state.currentTurnId, null);
  assert.equal(state.liveStatus?.state, "rejected");
  assert.equal(state.liveStatus?.message, "Rejected Bash. Pending decision cleared.");
  assert.equal(state.pendingApproval, null);
  assert.equal(state.pendingClarification, null);
  assert.equal(state.transcript.length, transcriptLength);
});

test("invalid turn status payload is ignored", () => {
  const state = initialState();

  const next = reduceShellState(state, {
    type: "gateway.event",
    method: "turn.status",
    params: {
      state: "not_a_state",
      kind: "not_a_state",
      text: "Nope",
      terminal: true,
    },
  });

  assert.equal(next, state);
});

test("runtime event envelope can carry turn status into reducer state", () => {
  let state = initialState();
  state = reduceShellState(state, {
    type: "gateway.event",
    method: "runtime.event",
    params: {
      version: 1,
      sequence: 3,
      type: "turn.status",
      timestamp: 1770000001,
      payload: {
        client_turn_id: "c1",
        state: "completed",
        kind: "completed",
        text: "Completed",
        terminal: true,
      },
    },
  });

  assert.equal(state.liveStatus?.state, "completed");
  assert.equal(state.turnRunning, false);
  assert.equal(state.currentTurnId, null);
});

test("gateway error event appends an error transcript row", () => {
  const state = reduceShellState(initialState(), {
    type: "gateway.event",
    method: "gateway.error",
    params: {
      code: "internal_error",
      message: "Internal gateway error.",
      detail: "status exploded",
      method: "status.inspect",
    },
  });

  const error = state.transcript.at(-1);
  assert.equal(error?.type, "error");
  assert.equal(error?.text, "Internal gateway error.");
  assert.deepEqual(error?.metadata, {
    code: "internal_error",
    message: "Internal gateway error.",
    detail: "status exploded",
    method: "status.inspect",
  });
});

test("gateway error event preserves stable request error codes", () => {
  const state = reduceShellState(initialState(), {
    type: "gateway.event",
    method: "gateway.error",
    params: {
      code: "turn_in_progress",
      message: "A turn is already running.",
      method: "turn.submit",
    },
  });

  const error = state.transcript.at(-1);
  assert.equal(error?.type, "error");
  assert.equal(error?.text, "A turn is already running.");
  assert.deepEqual(error?.metadata, {
    code: "turn_in_progress",
    message: "A turn is already running.",
    method: "turn.submit",
  });
});

test("request failure appends one error row and deduplicates matching gateway error", () => {
  let state = reduceShellState(initialState(), {
    type: "request.failed",
    method: "approval.respond",
    code: "decision_not_pending",
    message: "No pending decision.",
  });

  state = reduceShellState(state, {
    type: "gateway.event",
    method: "gateway.error",
    params: {
      code: "decision_not_pending",
      message: "No pending decision.",
      method: "approval.respond",
    },
  });

  const errors = state.transcript.filter((item) => item.type === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.text, "No pending decision.");
  assert.deepEqual(errors[0]?.metadata, {
    code: "decision_not_pending",
    message: "No pending decision.",
    method: "approval.respond",
    source: "request",
  });
});

test("failed terminal turn status appends one recoverable error row", () => {
  const state = reduceShellState(initialState(), {
    type: "gateway.event",
    method: "turn.status",
    params: {
      client_turn_id: "c1",
      state: "failed",
      kind: "failed",
      text: "Failed",
      terminal: true,
      message: "Provider failed after retries.",
    },
  });

  const errors = state.transcript.filter((item) => item.type === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.text, "Provider failed after retries.");
  assert.deepEqual(errors[0]?.metadata, {
    client_turn_id: "c1",
    state: "failed",
    kind: "failed",
    text: "Failed",
    terminal: true,
    message: "Provider failed after retries.",
  });
  assert.equal(state.liveStatus?.state, "failed");
  assert.equal(state.turnRunning, false);
});

test("failed terminal turn status does not duplicate prior turn failed errors", () => {
  let state = reduceShellState(initialState(), {
    type: "gateway.event",
    method: "turn.failed",
    params: {
      client_turn_id: "c1",
      message: "Provider failed after retries.",
    },
  });

  state = reduceShellState(state, {
    type: "gateway.event",
    method: "turn.status",
    params: {
      client_turn_id: "c1",
      state: "failed",
      kind: "failed",
      text: "Failed",
      terminal: true,
      message: "Provider failed after retries.",
    },
  });

  const errors = state.transcript.filter((item) => item.type === "error");
  assert.equal(errors.length, 1);
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
    method: "tool.progress",
    params: {
      client_turn_id: "c1",
      tool_id: "call_read_1",
      call_id: "call_read_1",
      name: "Read",
      stage: "executing",
      message: "Executing Read",
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
  assert.equal(tools[0]?.metadata.stage, "executing");
  assert.equal(tools[0]?.metadata.duration_s, 0.125);
  assert.equal(tools[0]?.metadata.tool_name, "Read");
});

test("runtime event envelope can carry tool progress into reducer state", () => {
  let state = initialState();
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
    method: "runtime.event",
    params: {
      version: 1,
      sequence: 7,
      type: "tool.progress",
      timestamp: 1770000001,
      payload: {
        client_turn_id: "c1",
        tool_id: "call_read_1",
        call_id: "call_read_1",
        name: "Read",
        stage: "executing",
        message: "Executing Read",
        args_preview: "file_path=pyproject.toml",
      },
    },
  });

  const tools = state.transcript.filter((item) => item.type === "tool_summary");
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.metadata.status, "running");
  assert.equal(tools[0]?.metadata.stage, "executing");
  assert.equal(tools[0]?.metadata.message, "Executing Read");
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
