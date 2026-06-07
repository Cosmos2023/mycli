import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { CompletionPopup } from "../src/app/CompletionPopup.tsx";

test("completion popup renders selected row marker", () => {
  const { lastFrame } = render(
    <CompletionPopup
      visible
      items={[
        { value: "/help", category: "local", description: "Show help.", mutating: false },
        { value: "/usage", category: "runtime", description: "Inspect usage.", mutating: false },
      ]}
      selectedIndex={1}
    />,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /\/help/);
  assert.match(frame, /> \/usage/);
  assert.match(frame, /\[runtime · read\]/);
  assert.match(frame, /Inspect usage/);
});
