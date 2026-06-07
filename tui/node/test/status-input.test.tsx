import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { StatusLine, statusMetadata } from "../src/app/StatusLine.tsx";
import { initialState } from "../src/state/reducer.ts";

test("status line renders compact session model theme and context", () => {
  const state = {
    ...initialState({ rawThemeName: "deep-teal" }),
    sessionId: "default",
    model: "deepseek/chat/deepseek-v4-flash",
    workspace: "/Users/cosmos/Desktop/mycli/.worktrees/fix-deepseek-cache-hit-rate",
    status: { context_window: { used_tokens: 9302, max_tokens: 100000 } },
  };

  const metadata = statusMetadata(state);
  assert.match(metadata, /sess: default/);
  assert.match(metadata, /deepseek-v4-flash/);
  assert.match(metadata, /deep-teal/);
  assert.match(metadata, /trust: unknown\*/);
  assert.match(metadata, /ctx: 9% 9,302\/100k/);

  const { lastFrame } = render(<StatusLine state={state} />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /session: default/);
  assert.match(frame, /model: deepseek-v4-flash/);
  assert.match(frame, /trust: unknown\*/);
  assert.match(frame, /theme: deep-teal/);
  assert.match(frame, /ctx: 9% 9,302\/100k/);
});

test("status line renders session title when present", () => {
  const state = {
    ...initialState({ rawThemeName: "deep-teal" }),
    sessionId: "default",
    sessionTitle: "Boss reply follow-up",
    model: "deepseek-v4",
  };

  const metadata = statusMetadata(state);
  assert.match(metadata, /title: Boss reply follow-up/);

  const frame = render(<StatusLine state={state} />).lastFrame() ?? "";
  assert.match(frame, /title: Boss reply follow-up/);
});

test("status metadata includes live status and approval marker", () => {
  const state = {
    ...initialState({ rawThemeName: "deep-teal" }),
    sessionId: "default",
    model: "deepseek-v4",
    liveStatus: {
      client_turn_id: "c1",
      state: "waiting_approval" as const,
      kind: "waiting_approval",
      text: "Waiting approval",
    },
    pendingApproval: {
      decision_id: "decision_current",
      preview: "git push",
      options: [{ choice: "approve_once" as const, label: "Allow once" }],
    },
  };

  const metadata = statusMetadata(state);
  assert.match(metadata, /Waiting approval/);
  assert.match(metadata, /approval pending/);
});

test("status metadata includes clarification marker", () => {
  const state = {
    ...initialState({ rawThemeName: "deep-teal" }),
    sessionId: "default",
    model: "deepseek-v4",
    pendingClarification: {
      request_id: "call_question_1",
      tool_id: "call_question_1",
      call_id: "call_question_1",
      tool_name: "AskUserQuestion",
      question: "Which slice should come next?",
      options: [{ label: "Runtime" }, { label: "TUI" }],
      multi_select: false,
    },
  };

  const metadata = statusMetadata(state);
  assert.match(metadata, /clarification pending/);
});

test("status metadata includes bounded live status detail", () => {
  const state = {
    ...initialState({ rawThemeName: "deep-teal" }),
    sessionId: "default",
    model: "deepseek-v4",
    liveStatus: {
      client_turn_id: "c1",
      state: "failed" as const,
      kind: "failed",
      text: "Failed",
      message: "Provider returned 429",
    },
  };

  const metadata = statusMetadata(state);
  assert.match(metadata, /Failed: Provider returned 429/);
});

test("status metadata truncates long live status detail", () => {
  const state = {
    ...initialState({ rawThemeName: "deep-teal" }),
    sessionId: "default",
    model: "deepseek-v4",
    liveStatus: {
      client_turn_id: "c1",
      state: "failed" as const,
      kind: "failed",
      text: "Failed",
      message:
        "Provider returned a very long upstream error message with internal diagnostics and retry metadata",
    },
  };

  const metadata = statusMetadata(state);
  assert.match(metadata, /Failed: Provid…metadata/);
  assert.doesNotMatch(metadata, /internal diagnostics and retry/);
});

test("completed live status remains hidden from metadata", () => {
  const state = {
    ...initialState({ rawThemeName: "deep-teal" }),
    sessionId: "default",
    model: "deepseek-v4",
    liveStatus: {
      client_turn_id: "c1",
      state: "completed" as const,
      kind: "completed",
      text: "Completed",
      message: "Done with detail",
    },
  };

  const metadata = statusMetadata(state);
  assert.doesNotMatch(metadata, /Completed/);
  assert.doesNotMatch(metadata, /Done with detail/);
});
