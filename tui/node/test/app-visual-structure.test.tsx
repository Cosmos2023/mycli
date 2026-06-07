import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/app/App.tsx";
import { initialState } from "../src/state/reducer.ts";

test("app renders Claude-style continuous transcript anatomy", () => {
  const state = {
    ...initialState({ rawThemeName: "graphite" }),
    sessionId: "default",
    sessionTitle: null,
    workspace: "/Users/cosmos/Desktop/mycli/.worktrees/fix-deepseek-cache-hit-rate",
    model: "deepseek/chat/deepseek-v4-flash",
    status: { context_window: { used_tokens: 9302, max_tokens: 100000 } },
    transcript: [
      { id: "u1", type: "user" as const, text: "你是谁", folded: false, metadata: {} },
      { id: "a1", type: "assistant_final" as const, text: "我是 mycli", folded: false, metadata: {} },
      { id: "u2", type: "user" as const, text: "读配置", folded: false, metadata: {} },
      {
        id: "t1",
        type: "tool_summary" as const,
        text: "Read pyproject.toml",
        folded: true,
        metadata: { tool_name: "Read", path: "pyproject.toml" },
      },
      { id: "d1", type: "tool_detail" as const, text: "raw config", folded: false, metadata: {} },
      { id: "a2", type: "assistant_final" as const, text: "已读取配置", folded: false, metadata: {} },
    ],
  };

  const { lastFrame } = render(<App state={state} width={80} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /mycli/);
  assert.match(frame, /fix-de/);
  assert.match(frame, /\[mycli\]/);
  assert.match(frame, /model: deepseek-v4-flash/);
  assert.match(frame, /❯ 你是谁/);
  assert.match(frame, /我是 mycli/);
  assert.match(frame, /❯ 读配置/);
  assert.match(frame, /✓ Read pyproject\.toml/);
  assert.match(frame, />/);
  assert.match(frame, /ctx: 9% 9,302\/100k/);
  assert.doesNotMatch(frame, /raw config/);
  assert.doesNotMatch(frame, /Type a message or \/command/);
  assert.doesNotMatch(frame, /Turn|\[assistant\]|\[tools\]|USER|ASSISTANT/);
});
