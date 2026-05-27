import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { InputBox } from "../src/app/InputBox.tsx";
import { initialState } from "../src/state/reducer.ts";

test("command bar renders divider prompt placeholder and compact metadata", () => {
  const state = {
    ...initialState({ rawThemeName: "graphite" }),
    workspace: "/repo/project",
    model: "deepseek-v4-flash",
    status: { context_window: { used_tokens: 3983, max_tokens: 100000 } },
  };

  const { lastFrame } = render(
    <InputBox
      draft=""
      turnRunning={false}
      completionVisible={false}
      theme={state.theme}
      metadata="default · graphite · 3,983/100k"
      width={80}
      onDraftChange={() => undefined}
      onSubmit={() => undefined}
      onInterrupt={() => undefined}
    />,
  );
  const frame = lastFrame() ?? "";

  assert.match(frame, /─/);
  assert.match(frame, /› Type a message or \/command/);
  assert.match(frame, /default · graphite/);
});

test("command bar shows command hint for slash drafts", () => {
  const state = initialState({ rawThemeName: "mono" });
  const { lastFrame } = render(
    <InputBox
      draft="/theme"
      turnRunning={false}
      completionVisible={false}
      theme={state.theme}
      metadata="default · mono"
      width={80}
      onDraftChange={() => undefined}
      onSubmit={() => undefined}
      onInterrupt={() => undefined}
    />,
  );

  assert.match(lastFrame() ?? "", /local UI command or Python slash command/);
});
