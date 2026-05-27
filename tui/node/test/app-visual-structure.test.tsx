import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/app/App.tsx";
import { initialState, reduceShellState } from "../src/state/reducer.ts";

test("app renders visual structure v2 anatomy", () => {
  let state = initialState({ rawThemeName: "graphite" });
  state = reduceShellState(state, {
    type: "bootstrap.result",
    payload: {
      session_id: "default",
      workspace: "/Users/cosmos/Desktop/mycli/.worktrees/fix-deepseek-cache-hit-rate",
      model: "deepseek/chat/deepseek-v4-flash",
      provider: "deepseek/chat_completions",
      status: { context_window: { used_tokens: 3983, max_tokens: 100000 } },
      welcome: { startup_mark: { name: "default", text: "mycli" }, tips: ["/help"] },
    },
  });
  state = reduceShellState(state, { type: "user.submit", message: "你是谁" });
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
        text: "我是 **mycli**，一个运行在本地机器上的编程助手。入口是 `mycli.cli.main:main`。",
        folded: false,
        metadata: {},
      },
    ],
  };

  const { lastFrame } = render(<App state={state} width={80} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /mycli/);
  assert.match(frame, /fix-de/);
  assert.match(frame, /deepseek/);
  assert.match(frame, /› 你是谁/);
  assert.match(frame, /read/);
  assert.match(frame, /pyproject\.toml/);
  assert.match(frame, /│/);
  assert.match(frame, /mycli\.cli\.main:main/);
  assert.match(frame, /Type a message or \/command/);
  assert.doesNotMatch(frame, /USER|ASSISTANT|TOOL/);
});
