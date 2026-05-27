import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { Header } from "../src/app/Header.tsx";
import { WelcomePanel, hasConversationContent } from "../src/app/WelcomePanel.tsx";
import { initialState, reduceShellState } from "../src/state/reducer.ts";

test("header band keeps core metadata inside compact width", () => {
  const state = {
    ...initialState({ rawThemeName: "graphite" }),
    sessionId: "default",
    workspace: "/Users/cosmos/Desktop/mycli/.worktrees/fix-deepseek-cache-hit-rate",
    model: "deepseek/chat/deepseek-v4-flash",
    status: { context_window: { used_tokens: 3983, max_tokens: 100000 } },
  };

  const { lastFrame } = render(<Header state={state} width={80} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /mycli/);
  assert.match(frame, /fix-de/);
  assert.match(frame, /deepseek-v4-flash|deepseek/);
  assert.match(frame, /4% 3,983\/100k/);
  assert.doesNotMatch(frame, /\.worktrees\/fix-deepseek-cache-hit-rate/);
});

test("welcome panel renders startup mark only before conversation content", () => {
  let state = reduceShellState(initialState({ rawThemeName: "deep-teal" }), {
    type: "bootstrap.result",
    payload: {
      session_id: "demo",
      workspace: "/repo/project",
      model: "deepseek-v4",
      provider: "deepseek/chat_completions",
      status: {},
      welcome: { startup_mark: { name: "default", text: "mycli-mark" }, tips: ["/help"] },
    },
  });

  assert.equal(hasConversationContent(state.transcript), false);
  assert.match(render(<WelcomePanel state={state} width={80} />).lastFrame() ?? "", /mycli-mark/);

  state = reduceShellState(state, { type: "user.submit", message: "你是谁" });

  assert.equal(hasConversationContent(state.transcript), true);
  assert.equal(render(<WelcomePanel state={state} width={80} />).lastFrame(), "");
});
