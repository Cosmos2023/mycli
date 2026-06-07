import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { TrustPrompt } from "../src/app/TrustPrompt.tsx";
import { initialState } from "../src/state/reducer.ts";

test("trust prompt renders unknown workspace trust with read-only guidance", () => {
  const state = {
    ...initialState({ rawThemeName: "graphite" }),
    workspace: "/repo/project",
    trust: {
      state: "unknown" as const,
      workspace: "/repo/project",
      source: "fallback",
      enforced: false,
    },
  };

  const { lastFrame } = render(<TrustPrompt state={state} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /Workspace trust/);
  assert.match(frame, /Do you trust this folder/);
  assert.match(frame, /\/repo\/project/);
  assert.match(frame, /read-only\/chat/);
  assert.match(frame, /runtime enforcement pending/);
});

test("trust prompt maps numeric choices without mutating runtime state locally", () => {
  const choices: string[] = [];
  const { stdin } = render(
    <TrustPrompt
      state={{
        ...initialState(),
        trust: { state: "unknown", workspace: "/repo/project", enforced: false },
      }}
      onTrustChoice={(choice) => choices.push(choice)}
    />,
  );

  stdin.write("1");
  stdin.write("2");
  stdin.write("3");

  assert.deepEqual(choices, ["trusted", "untrusted", "later"]);
});

test("trust prompt hides for trusted workspaces", () => {
  const { lastFrame } = render(
    <TrustPrompt
      state={{
        ...initialState(),
        trust: { state: "trusted", workspace: "/repo/project", enforced: true },
      }}
    />,
  );

  assert.equal(lastFrame(), "");
});
