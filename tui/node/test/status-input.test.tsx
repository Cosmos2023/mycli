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
  assert.match(metadata, /default/);
  assert.match(metadata, /deepseek-v4-flash/);
  assert.match(metadata, /deep-teal/);
  assert.match(metadata, /9% 9,302\/100k/);

  const { lastFrame } = render(<StatusLine state={state} />);
  assert.match(lastFrame() ?? "", /deepseek-v4-flash/);
});
