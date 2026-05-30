import assert from "node:assert/strict";
import test from "node:test";
import {
  applyToolEvent,
  applyToolLifecycleEvent,
  reconcileFinalAnswer,
} from "../src/state/transcript.ts";
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

test("tool call preserves top-level name and streamed arguments metadata", () => {
  const items: TranscriptItem[] = [];
  const next = applyToolEvent(items, {
    client_turn_id: "c1",
    phase: "tool_call",
    kind: "tool_call",
    tool_name: "Read",
    metadata: { arguments: { file_path: "pyproject.toml" } },
  });

  assert.equal(next[0]?.metadata.tool_name, "Read");
  assert.deepEqual(next[0]?.metadata.arguments, { file_path: "pyproject.toml" });
});

test("tool lifecycle start creates running summary and complete updates it in place", () => {
  let items: TranscriptItem[] = [];

  items = applyToolLifecycleEvent(items, "tool.start", {
    client_turn_id: "c1",
    tool_id: "call_read_1",
    call_id: "call_read_1",
    name: "Read",
    context: "pyproject.toml",
    args_preview: "file_path=pyproject.toml",
  });
  items = applyToolLifecycleEvent(items, "tool.complete", {
    client_turn_id: "c1",
    tool_id: "call_read_1",
    call_id: "call_read_1",
    name: "Read",
    duration_s: 0.125,
    summary: "Read pyproject.toml",
    success: true,
  });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.type, "tool_summary");
  assert.equal(items[0]?.metadata.status, "done");
  assert.equal(items[0]?.metadata.tool_id, "call_read_1");
  assert.equal(items[0]?.metadata.tool_name, "Read");
  assert.equal(items[0]?.metadata.duration_s, 0.125);
  assert.equal(items[0]?.metadata.summary, "Read pyproject.toml");
});

test("tool lifecycle failed completion creates fallback failed summary", () => {
  const items = applyToolLifecycleEvent([], "tool.failed", {
    client_turn_id: "c1",
    tool_id: "call_write_1",
    call_id: "call_write_1",
    name: "Write",
    duration_s: 0.002,
    summary: "Tool Write could not run because its arguments were invalid.",
    success: false,
    error: "Missing required arguments: content",
  });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.type, "tool_summary");
  assert.equal(items[0]?.metadata.status, "failed");
  assert.equal(items[0]?.metadata.error, "Missing required arguments: content");
  assert.equal(items[0]?.text, "Write Tool Write could not run because its arguments were invalid.");
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
