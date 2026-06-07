import assert from "node:assert/strict";
import test from "node:test";
import { interruptIntent } from "../src/state/interrupt.ts";
import { initialState } from "../src/state/reducer.ts";

test("interrupt intent closes overlays before touching running turns", () => {
  assert.equal(
    interruptIntent({
      ...initialState(),
      turnRunning: true,
      overlay: { visible: true, title: "/logs", lines: ["tail"] },
    }),
    "close_overlay",
  );
});

test("interrupt intent requests turn interrupt while running", () => {
  assert.equal(interruptIntent({ ...initialState(), turnRunning: true }), "interrupt_turn");
});

test("interrupt intent clears non-empty draft before exiting", () => {
  assert.equal(interruptIntent({ ...initialState(), inputDraft: "hello" }), "clear_input");
});

test("interrupt intent exits when idle", () => {
  assert.equal(interruptIntent(initialState()), "exit");
});
