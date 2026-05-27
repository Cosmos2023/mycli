import assert from "node:assert/strict";
import test from "node:test";
import {
  contentWidth,
  formatContextUsage,
  modelLabel,
  truncateMiddle,
  workspaceLabel,
} from "../src/app/layout.ts";

test("truncateMiddle preserves short values and elides long values", () => {
  assert.equal(truncateMiddle("short", 10), "short");
  assert.equal(truncateMiddle("abcdefghijklmnopqrstuvwxyz", 12), "abcd…vwxyz");
  assert.equal(truncateMiddle("abcdefghijklmnopqrstuvwxyz", 5), "ab…yz");
});

test("workspaceLabel returns basename and truncates long basenames", () => {
  assert.equal(workspaceLabel("/repo/project", 20), "project");
  assert.equal(workspaceLabel("/repo/fix-deepseek-cache-hit-rate", 16), "fix-de…hit-rate");
  assert.equal(workspaceLabel("", 12), "workspace");
});

test("modelLabel strips provider-like prefixes and truncates", () => {
  assert.equal(modelLabel("deepseek/chat/deepseek-v4-flash", 30), "deepseek-v4-flash");
  assert.equal(modelLabel("very-long-provider/model-with-a-very-long-name", 18), "model-…ong-name");
  assert.equal(modelLabel("", 8), "model");
});

test("formatContextUsage supports numeric and missing status values", () => {
  assert.equal(
    formatContextUsage({ context_window: { used_tokens: 3983, max_tokens: 100000 } }),
    "4% 3,983/100k",
  );
  assert.equal(formatContextUsage({}), "context --");
});

test("contentWidth bounds assistant column for compact normal and wide terminals", () => {
  assert.equal(contentWidth(72), 64);
  assert.equal(contentWidth(100), 88);
  assert.equal(contentWidth(180), 100);
});
