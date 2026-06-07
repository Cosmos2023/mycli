import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { Badge } from "../src/app/ui/Badge.tsx";
import { Panel } from "../src/app/ui/Panel.tsx";
import { StatusPill } from "../src/app/ui/StatusPill.tsx";
import { THEMES } from "../src/theme/themes.ts";

test("badge renders compact semantic label", () => {
  const { lastFrame } = render(
    <Badge variant="success" theme={THEMES["deep-teal"]}>
      ready
    </Badge>,
  );

  assert.match(lastFrame() ?? "", /\[ready\]/);
});

test("status pill renders label and value with stable separator", () => {
  const { lastFrame } = render(
    <StatusPill label="model" value="deepseek-v4" theme={THEMES.graphite} />,
  );

  assert.match(lastFrame() ?? "", /model: deepseek-v4/);
});

test("panel renders title, subtitle, body, and footer", () => {
  const { lastFrame } = render(
    <Panel
      title="Runtime"
      subtitle="policy snapshot"
      footer="Esc close"
      theme={THEMES.amber}
      width={48}
    >
      <Badge variant="warning" theme={THEMES.amber}>
        approval
      </Badge>
    </Panel>,
  );

  const frame = lastFrame() ?? "";
  assert.match(frame, /Runtime/);
  assert.match(frame, /policy snapshot/);
  assert.match(frame, /\[approval\]/);
  assert.match(frame, /Esc close/);
});
