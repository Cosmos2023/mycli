import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { InputBox } from "../src/app/InputBox.tsx";
import { initialState } from "../src/state/reducer.ts";

test("input box renders minimal prompt and metadata below input", () => {
  const state = initialState({ rawThemeName: "graphite" });
  const { lastFrame } = render(
    <InputBox
      draft=""
      turnRunning={false}
      completionVisible={false}
      theme={state.theme}
      metadata="default · deepseek-v4-flash · graphite · 9% 9,302/100k"
      hint="Enter send · / commands · Ctrl-C interrupt"
      width={80}
      onDraftChange={() => undefined}
      onSubmit={() => undefined}
      onInterrupt={() => undefined}
    />,
  );
  const frame = lastFrame() ?? "";

  assert.match(frame, />/);
  assert.match(frame, /Enter send · \/ commands · Ctrl-C interrupt/);
  assert.match(frame, /default · deepseek-v4-flash/);
  assert.doesNotMatch(frame, /Type a message or \/command/);
});

test("input box renders current draft next to prompt", () => {
  const state = initialState({ rawThemeName: "deep-teal" });
  const { lastFrame } = render(
    <InputBox
      draft="/usage"
      turnRunning={false}
      completionVisible={false}
      theme={state.theme}
      metadata="default · model"
      hint="Enter send · / commands · Ctrl-C interrupt"
      width={80}
      onDraftChange={() => undefined}
      onSubmit={() => undefined}
      onInterrupt={() => undefined}
    />,
  );
  const frame = lastFrame() ?? "";

  assert.match(frame, /> \/usage/);
  assert.doesNotMatch(frame, /local UI command or Python slash command/);
});
