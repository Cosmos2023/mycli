import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptSelected,
  completionWindow,
  moveSelection,
  shouldComplete,
} from "../src/state/completion.ts";
import { initialState, reduceShellState } from "../src/state/reducer.ts";

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

test("reducer opens slash completion from catalog and accepts selected command", () => {
  let state = initialState();

  state = reduceShellState(state, { type: "input.changed", value: "/sta" });

  assert.equal(state.completion.visible, true);
  assert.deepEqual(
    state.completion.items.map((item) => item.value),
    ["/status", "/statusbar"],
  );
  assert.equal(state.completion.items[0]?.category, "runtime");
  assert.equal(state.completion.items[1]?.mutating, true);

  state = reduceShellState(state, { type: "completion.move", delta: 1 });
  state = reduceShellState(state, { type: "completion.accept" });

  assert.equal(state.inputDraft, "/statusbar");
  assert.equal(state.completion.visible, false);
});
