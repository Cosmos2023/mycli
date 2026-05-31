import assert from "node:assert/strict";
import test from "node:test";
import {
  currentTurn,
  groupTranscriptIntoTurns,
  visibleTurnsForMode,
} from "../src/app/displayModel.ts";
import type { TranscriptItem } from "../src/state/types.ts";

function item(
  id: string,
  type: TranscriptItem["type"],
  text: string,
  metadata: Record<string, unknown> = {},
): TranscriptItem {
  return { id, type, text, folded: false, metadata };
}

test("groupTranscriptIntoTurns returns prelude and starts a turn at each user item", () => {
  const grouped = groupTranscriptIntoTurns([
    item("w1", "system_notice", "welcome", { startup_mark: { name: "default" } }),
    item("u1", "user", "你是谁"),
    item("a1", "assistant_final", "我是 mycli"),
    item("u2", "user", "有哪些 skill"),
    item("t1", "tool_summary", "Read AGENTS.md", { tool_name: "Read", path: "AGENTS.md" }),
    item("q1", "clarification", "Pick one", { options: [{ label: "Runtime" }] }),
    item("d1", "tool_detail", "AGENTS content"),
    item("a2", "assistant_final", "两个 skill"),
  ]);

  assert.equal(grouped.prelude.length, 1);
  assert.equal(grouped.turns.length, 2);
  assert.equal(grouped.turns[0]?.user?.text, "你是谁");
  assert.equal(grouped.turns[0]?.assistantFinal?.text, "我是 mycli");
  assert.equal(grouped.turns[1]?.tools.length, 1);
  assert.equal(grouped.turns[1]?.clarifications.length, 1);
  assert.equal(grouped.turns[1]?.toolDetails.length, 1);
});

test("items before the first user stay in prelude", () => {
  const grouped = groupTranscriptIntoTurns([
    item("n1", "command_output", "Theme changed"),
    item("u1", "user", "hello"),
    item("a1", "assistant_final", "hi"),
  ]);

  assert.deepEqual(
    grouped.prelude.map((entry) => entry.id),
    ["n1"],
  );
  assert.deepEqual(
    grouped.turns.map((turn) => turn.id),
    ["turn_u1"],
  );
});

test("currentTurn returns the last grouped turn", () => {
  const grouped = groupTranscriptIntoTurns([
    item("u1", "user", "one"),
    item("a1", "assistant_final", "answer one"),
    item("u2", "user", "two"),
  ]);

  assert.equal(currentTurn(grouped.turns)?.user?.text, "two");
});

test("visibleTurnsForMode keeps prior turns in default and verbose but only current in focus", () => {
  const grouped = groupTranscriptIntoTurns([
    item("u1", "user", "one"),
    item("a1", "assistant_final", "answer one"),
    item("u2", "user", "two"),
    item("a2", "assistant_final", "answer two"),
  ]);

  assert.deepEqual(
    visibleTurnsForMode(grouped.turns, "default").map((turn) => turn.id),
    ["turn_u1", "turn_u2"],
  );
  assert.deepEqual(
    visibleTurnsForMode(grouped.turns, "verbose").map((turn) => turn.id),
    ["turn_u1", "turn_u2"],
  );
  assert.deepEqual(
    visibleTurnsForMode(grouped.turns, "focus").map((turn) => turn.id),
    ["turn_u2"],
  );
});
