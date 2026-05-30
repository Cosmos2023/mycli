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
      options: [{ choice: "approve_once", label: "Allow once" }],
    },
  };

  const metadata = statusMetadata(state);
  assert.match(metadata, /Waiting approval/);
  assert.match(metadata, /approval pending/);
});
