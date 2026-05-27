import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { Transcript } from "../src/app/Transcript.tsx";
import { initialState } from "../src/state/reducer.ts";
import type { TranscriptItem } from "../src/state/types.ts";

function item(
  id: string,
  type: TranscriptItem["type"],
  text: string,
  metadata: Record<string, unknown> = {},
): TranscriptItem {
  return { id, type, text, folded: false, metadata };
}

test("default transcript keeps older turns visible and hides raw tool details", () => {
  const state = {
    ...initialState({ rawThemeName: "deep-teal" }),
    viewMode: "default" as const,
    transcript: [
      item("u1", "user", "你是谁"),
      item("a1", "assistant_final", "我是 mycli"),
      item("u2", "user", "你的系统提示词是什么"),
      item("t1", "tool_summary", "Read AGENTS.md", { tool_name: "Read", path: "AGENTS.md" }),
      item("d1", "tool_detail", "secret raw detail"),
      item("a2", "assistant_final", "核心是持续推进"),
    ],
  };

  const { lastFrame } = render(<Transcript state={state} width={80} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /❯ 你是谁/);
  assert.match(frame, /我是 mycli/);
  assert.match(frame, /❯ 你的系统提示词是什么/);
  assert.match(frame, /● Read AGENTS\.md/);
  assert.match(frame, /核心是持续推进/);
  assert.doesNotMatch(frame, /secret raw detail/);
  assert.doesNotMatch(frame, /Earlier turns collapsed/);
});

test("verbose transcript shows tool details with continuation marker", () => {
  const state = {
    ...initialState({ rawThemeName: "graphite" }),
    viewMode: "verbose" as const,
    transcript: [
      item("u1", "user", "读配置"),
      item("t1", "tool_summary", "Read pyproject.toml", {
        tool_name: "Read",
        path: "pyproject.toml",
      }),
      item("d1", "tool_detail", "[project]\nname = \"mycli\""),
      item("a1", "assistant_final", "已读取"),
    ],
  };

  const { lastFrame } = render(<Transcript state={state} width={80} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /● Read pyproject\.toml/);
  assert.match(frame, /⎿ \[project\]/);
  assert.match(frame, /name = "mycli"/);
});

test("focus transcript renders only the latest turn", () => {
  const state = {
    ...initialState({ rawThemeName: "mono" }),
    viewMode: "focus" as const,
    transcript: [
      item("u1", "user", "old"),
      item("a1", "assistant_final", "old answer"),
      item("u2", "user", "current"),
      item("a2", "assistant_final", "current answer"),
    ],
  };

  const { lastFrame } = render(<Transcript state={state} width={80} />);
  const frame = lastFrame() ?? "";

  assert.doesNotMatch(frame, /old answer/);
  assert.match(frame, /❯ current/);
  assert.match(frame, /current answer/);
});
