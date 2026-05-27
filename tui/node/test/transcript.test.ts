import assert from "node:assert/strict";
import test from "node:test";
import { applyToolEvent, reconcileFinalAnswer } from "../src/state/transcript.ts";
import type { TranscriptItem } from "../src/state/types.ts";

test("tool call creates folded summary in default view", () => {
  const items: TranscriptItem[] = [];
  const next = applyToolEvent(items, {
    client_turn_id: "c1",
    phase: "tool_call",
    kind: "tool_call",
    tool_name: "Read",
    metadata: { path: "pyproject.toml" },
  });

  assert.equal(next[0]?.type, "tool_summary");
  assert.equal(next[0]?.folded, true);
  assert.match(next[0]?.text ?? "", /Read/);
});

test("final answer replaces active stream without duplication", () => {
  const items: TranscriptItem[] = [
    { id: "a1", type: "assistant_stream", text: "hello", folded: false, metadata: {} },
  ];

  const next = reconcileFinalAnswer(items, "hello final");

  assert.equal(next.length, 1);
  assert.equal(next[0]?.type, "assistant_final");
  assert.equal(next[0]?.text, "hello final");
});
