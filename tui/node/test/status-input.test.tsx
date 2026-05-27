import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { Header } from "../src/app/Header.tsx";
import { InputBox } from "../src/app/InputBox.tsx";
import { StatusLine } from "../src/app/StatusLine.tsx";
import { initialState, reduceShellState } from "../src/state/reducer.ts";

test("header renders mycli brand, workspace, session, and theme", () => {
  const state = reduceShellState(initialState({ rawThemeName: "deep-teal" }), {
    type: "bootstrap.result",
    payload: {
      session_id: "demo",
      workspace: "/repo/project",
      model: "deepseek-v4",
      provider: "deepseek/chat_completions",
      status: { context_window: { used_tokens: 3983, max_tokens: 100000 } },
      welcome: {
        startup_mark: { name: "default", text: "mycli-mark" },
        tips: ["/help", "/usage"],
      },
    },
  });

  const { lastFrame } = render(<Header state={state} width={100} />);

  const frame = lastFrame() ?? "";
  assert.match(frame, /mycli/);
  assert.match(frame, /demo/);
  assert.match(frame, /deep-teal/);
  assert.match(frame, /project/);
});

test("status line renders compact workspace, view, theme, model, and context", () => {
  const state = {
    ...initialState({ rawThemeName: "mono" }),
    workspace: "/repo/project",
    model: "deepseek-v4",
    viewMode: "verbose" as const,
    status: { context_window: { used_tokens: 3983, max_tokens: 100000 } },
  };

  const { lastFrame } = render(<StatusLine state={state} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /project/);
  assert.match(frame, /verbose/);
  assert.match(frame, /mono/);
  assert.match(frame, /4% 3,983\/100k/);
});

test("input shows placeholder and command hint", () => {
  const idle = render(
    <InputBox
      draft=""
      turnRunning={false}
      completionVisible={false}
      theme={initialState().theme}
      metadata="default · deep-teal"
      width={80}
      onDraftChange={() => undefined}
      onSubmit={() => undefined}
      onInterrupt={() => undefined}
    />,
  );
  assert.match(idle.lastFrame() ?? "", /Type a message or \/command/);

  const command = render(
    <InputBox
      draft="/theme"
      turnRunning={false}
      completionVisible={false}
      theme={initialState().theme}
      metadata="default · deep-teal"
      width={80}
      onDraftChange={() => undefined}
      onSubmit={() => undefined}
      onInterrupt={() => undefined}
    />,
  );
  assert.match(command.lastFrame() ?? "", /local UI command/);
});
