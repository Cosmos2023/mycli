import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { RunningActivity, activityPath } from "../src/app/RunningActivity.tsx";
import { ToolResultRow } from "../src/app/ToolResultRow.tsx";
import { ToolRow } from "../src/app/ToolRow.tsx";
import { initialState } from "../src/state/reducer.ts";

test("tool row renders Claude-style tool call summary", () => {
  const state = initialState({ rawThemeName: "deep-teal" });
  const { lastFrame } = render(
    <ToolRow
      summary={{ verb: "read", target: "pyproject.toml", status: "done", detail: "82ms" }}
      theme={state.theme}
      width={80}
    />,
  );
  const frame = lastFrame() ?? "";

  assert.match(frame, /● Read pyproject\.toml · 82ms/);
  assert.doesNotMatch(frame, /done 82ms/);
});

test("tool result row renders continuation marker", () => {
  const state = initialState({ rawThemeName: "graphite" });
  const { lastFrame } = render(
    <ToolResultRow text={"[project]\nname = \"mycli\""} theme={state.theme} />,
  );
  const frame = lastFrame() ?? "";

  assert.match(frame, /⎿ \[project\]/);
  assert.match(frame, /name = "mycli"/);
});

test("activity path derives compact recent tool path", () => {
  const state = {
    ...initialState({ rawThemeName: "mono" }),
    transcript: [
      {
        id: "t1",
        type: "tool_summary" as const,
        text: "Read pyproject.toml",
        folded: true,
        metadata: { tool_name: "Read", path: "pyproject.toml" },
      },
      {
        id: "t2",
        type: "tool_summary" as const,
        text: "Grep NodeTuiGateway",
        folded: true,
        metadata: { tool_name: "Grep", query: "NodeTuiGateway" },
      },
    ],
  };

  assert.equal(activityPath(state.transcript), "read → grep");
});

test("running activity line renders Claude-style thinking row", () => {
  const state = {
    ...initialState({ rawThemeName: "graphite" }),
    turnRunning: true,
    transcript: [
      {
        id: "t1",
        type: "tool_summary" as const,
        text: "Read pyproject.toml",
        folded: true,
        metadata: { tool_name: "Read", path: "pyproject.toml" },
      },
    ],
  };

  const { lastFrame } = render(<RunningActivity state={state} elapsedSeconds={12} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /● Thinking 12s · read/);
});

test("running activity prefers live status update text", () => {
  const state = {
    ...initialState({ rawThemeName: "graphite" }),
    turnRunning: true,
    liveStatus: {
      client_turn_id: "c1",
      state: "waiting_approval" as const,
      kind: "waiting_approval",
      text: "Waiting approval",
    },
    transcript: [
      {
        id: "t1",
        type: "tool_summary" as const,
        text: "Read pyproject.toml",
        folded: true,
        metadata: { tool_name: "Read", path: "pyproject.toml" },
      },
    ],
  };

  const { lastFrame } = render(<RunningActivity state={state} elapsedSeconds={12} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /● Waiting approval 12s · read/);
});
