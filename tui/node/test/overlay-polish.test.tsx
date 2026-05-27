import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { CommandOutput } from "../src/app/CommandOutput.tsx";
import { Overlay } from "../src/app/Overlay.tsx";
import { SystemNotice } from "../src/app/SystemNotice.tsx";
import { THEMES } from "../src/theme/themes.ts";

test("overlay renders title content footer and truncation marker", () => {
  const { lastFrame } = render(
    <Overlay
      theme={THEMES["deep-teal"]}
      overlay={{
        visible: true,
        title: "/usage",
        lines: ["line 1", "line 2", "line 3", "line 4"],
      }}
      maxLines={2}
    />,
  );

  const frame = lastFrame() ?? "";
  assert.match(frame, /\/usage/);
  assert.match(frame, /line 1/);
  assert.match(frame, /line 2/);
  assert.match(frame, /2 more lines/);
  assert.match(frame, /Esc close/);
});

test("command output and system notice render compact text", () => {
  const command = render(<CommandOutput text="[view] view_mode=verbose" theme={THEMES.mono} />);
  assert.match(command.lastFrame() ?? "", /\[view\] view_mode=verbose/);

  const notice = render(<SystemNotice text="Visible transcript cleared." theme={THEMES.mono} />);
  assert.match(notice.lastFrame() ?? "", /Visible transcript cleared/);
});
