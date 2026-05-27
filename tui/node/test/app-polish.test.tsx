import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/app/App.tsx";
import { initialState, reduceShellState } from "../src/state/reducer.ts";

test("app renders branded console anatomy", () => {
  let state = initialState({ rawThemeName: "deep-teal" });
  state = reduceShellState(state, {
    type: "bootstrap.result",
    payload: {
      session_id: "demo",
      workspace: "/repo/project",
      model: "deepseek-v4",
      provider: "deepseek/chat_completions",
      status: { context_window: { used_tokens: 3983, max_tokens: 100000 } },
      welcome: { startup_mark: { name: "default", text: "mycli" }, tips: ["/help"] },
    },
  });
  state = reduceShellState(state, { type: "user.submit", message: "read pyproject" });
  state = {
    ...state,
    transcript: [
      ...state.transcript,
      {
        id: "tool_1",
        type: "tool_summary",
        text: "Read pyproject.toml",
        folded: true,
        metadata: { tool_name: "Read", path: "pyproject.toml", duration_ms: 82 },
      },
      {
        id: "assistant_1",
        type: "assistant_final",
        text: "Project is **mycli** and entry is `mycli.cli.main:main`.",
        folded: false,
        metadata: {},
      },
    ],
  };

  const { lastFrame } = render(<App state={state} width={100} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /mycli/);
  assert.match(frame, /project/);
  assert.match(frame, /deepseek-v4/);
  assert.match(frame, /❯ read pyproject/);
  assert.match(frame, /● Read pyproject\.toml · 82ms/);
  assert.match(frame, /mycli\.cli\.main:main/);
  assert.match(frame, />/);
  assert.doesNotMatch(frame, /Type a message or \/command/);
  assert.doesNotMatch(frame, /USER|ASSISTANT|TOOL/);
  assert.doesNotMatch(frame, /│/);
});
