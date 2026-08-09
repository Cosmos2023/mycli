import assert from "node:assert/strict";
import test from "node:test";

test("contracts workspace is available", () => {
  assert.ok(Number(process.versions.node.split(".")[0]) >= 22);
});
