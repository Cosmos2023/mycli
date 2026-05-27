import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { CompletionPopup } from "../src/app/CompletionPopup.tsx";

test("completion popup renders selected row marker", () => {
  const { lastFrame } = render(
    <CompletionPopup
      visible
      items={[{ value: "/help" }, { value: "/usage" }]}
      selectedIndex={1}
    />,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /\/help/);
  assert.match(frame, /> \/usage/);
});
