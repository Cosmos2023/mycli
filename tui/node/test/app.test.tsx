import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { Overlay } from "../src/app/Overlay.tsx";
import { StatusLine } from "../src/app/StatusLine.tsx";
import { Transcript } from "../src/app/Transcript.tsx";
import { THEMES } from "../src/theme/themes.ts";
import type { ShellState } from "../src/state/types.ts";

const state: ShellState = {
  sessionId: "demo",
  workspace: "/repo",
  model: "deepseek-v4",
  provider: "deepseek/chat_completions",
  status: { context_window: { used_tokens: 3983, max_tokens: 100000 } },
  themeName: "deep-teal",
  theme: THEMES["deep-teal"],
  themeNotice: null,
  transcript: [
    { id: "u1", type: "user", text: "read pyproject", folded: false, metadata: {} },
    {
      id: "t1",
      type: "tool_summary",
      text: "Read pyproject.toml",
      folded: true,
      metadata: { tool_name: "Read", path: "pyproject.toml" },
    },
    { id: "a1", type: "assistant_final", text: "Project is mycli.", folded: false, metadata: {} },
  ],
  inputDraft: "",
  restoredDraft: "",
  turnRunning: false,
  currentTurnId: null,
  liveStatus: null,
  liveReasoning: null,
  typedMessageTurnId: null,
  viewMode: "default",
  completion: { visible: false, requestId: 0, prefix: "", items: [], selectedIndex: 0 },
  overlay: { visible: true, title: "/usage", lines: ["turns=1"] },
  pendingApproval: null,
  pendingClarification: null,
};

test("transcript renders user, folded tool summary, and answer without role cards", () => {
  const { lastFrame } = render(<Transcript state={state} />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /❯ read pyproject/);
  assert.match(frame, /● Read pyproject\.toml/);
  assert.match(frame, /Project is mycli/);
  assert.doesNotMatch(frame, /USER|ASSISTANT|TOOL/);
  assert.doesNotMatch(frame, /│/);
});

test("status line renders compact metadata and context usage", () => {
  const { lastFrame } = render(<StatusLine state={state} />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /demo/);
  assert.match(frame, /deepseek-v4/);
  assert.match(frame, /deep-teal/);
  assert.match(frame, /4% 3,983\/100k/);
});

test("overlay renders command lines", () => {
  const { lastFrame } = render(<Overlay overlay={state.overlay} theme={state.theme} />);
  assert.match(lastFrame() ?? "", /\/usage/);
  assert.match(lastFrame() ?? "", /turns=1/);
});
