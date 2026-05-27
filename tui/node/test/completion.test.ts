import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptSelected,
  completionWindow,
  moveSelection,
  shouldComplete,
} from "../src/state/completion.ts";

const items = ["/help", "/status", "/usage", "/context", "/sessions", "/quit", "/view"].map(
  (value) => ({ value }),
);

test("slash prefix opens completion without submitting bare slash", () => {
  assert.equal(shouldComplete("/"), "slash");
  assert.equal(shouldComplete("/sta"), "slash");
  assert.equal(shouldComplete("hello"), null);
});

test("selection movement wraps and keeps row in visible window", () => {
  assert.equal(moveSelection(0, 1, items.length), 1);
  assert.equal(moveSelection(0, -1, items.length), items.length - 1);
  const window = completionWindow(items, 6, 6);
  assert.deepEqual(window.map((item) => item.value), [
    "/status",
    "/usage",
    "/context",
    "/sessions",
    "/quit",
    "/view",
  ]);
});

test("accept selected inserts command text", () => {
  assert.equal(acceptSelected(items, 2), "/usage");
});
