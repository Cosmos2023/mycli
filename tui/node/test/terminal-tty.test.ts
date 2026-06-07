import assert from "node:assert/strict";
import test from "node:test";
import { TtyOpenError, ttyOpenFailureMessage } from "../src/terminal/tty.ts";

test("tty open failure message is actionable and bounded", () => {
  const message = ttyOpenFailureMessage(new Error("ENXIO: no such device"));

  assert.match(message, /Unable to open \/dev\/tty/);
  assert.match(message, /interactive terminal/);
  assert.match(message, /scripted\/plain CLI/);
  assert.match(message, /ENXIO/);
  assert.doesNotMatch(message, /at .*tty/);
});

test("tty open error exposes a stable name", () => {
  const error = new TtyOpenError("failed");

  assert.equal(error.name, "TtyOpenError");
  assert.equal(error.message, "failed");
});
