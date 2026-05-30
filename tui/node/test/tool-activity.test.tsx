import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { RunningActivity, activityPath, activityStyle } from "../src/app/RunningActivity.tsx";
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

test("tool row renders running and failed lifecycle summaries", () => {
  const state = initialState({ rawThemeName: "deep-teal" });
  const running = render(
    <ToolRow
      summary={{ verb: "read", target: "pyproject.toml", status: "running" }}
      theme={state.theme}
      width={80}
    />,
  ).lastFrame();
  const failed = render(
    <ToolRow
      summary={{ verb: "write", target: "notes.txt", status: "failed", detail: "2ms" }}
      theme={state.theme}
      width={80}
    />,
  ).lastFrame();

  assert.match(running ?? "", /● Read pyproject\.toml/);
  assert.match(failed ?? "", /● Write notes\.txt · 2ms/);
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

  assert.match(frame, /! Waiting approval 12s · read/);
});

test("running activity renders compact live reasoning preview", () => {
  const state = {
    ...initialState({ rawThemeName: "graphite" }),
    turnRunning: true,
    liveReasoning: {
      client_turn_id: "c1",
      kind: "reasoning" as const,
      text: "checking project structure",
    },
    transcript: [],
  };

  const { lastFrame } = render(<RunningActivity state={state} elapsedSeconds={3} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /● Thinking 3s · reasoning: checking project structure/);
});

test("running activity maps live states to semantic styles", () => {
  const state = initialState({ rawThemeName: "deep-teal" });

  assert.deepEqual(activityStyle("running", state.theme), {
    color: state.theme.accent,
    glyph: "●",
  });
  assert.deepEqual(activityStyle("waiting_approval", state.theme), {
    color: state.theme.warning,
    glyph: "!",
  });
  assert.deepEqual(activityStyle("failed", state.theme), {
    color: state.theme.error,
    glyph: "x",
  });
});
