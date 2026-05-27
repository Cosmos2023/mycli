import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { MarkdownText } from "../src/app/MarkdownText.tsx";
import { THEMES } from "../src/theme/themes.ts";

test("renders inline code and bold as readable terminal text", () => {
  const { lastFrame } = render(
    <MarkdownText
      text="Project is **mycli** and entry is `mycli.cli.main:main`."
      theme={THEMES["deep-teal"]}
    />,
  );
  const frame = lastFrame() ?? "";
  assert.match(frame, /mycli/);
  assert.match(frame, /mycli\.cli\.main:main/);
});

test("renders unordered lists", () => {
  const { lastFrame } = render(<MarkdownText text={"- one\n- two"} theme={THEMES.mono} />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /• one/);
  assert.match(frame, /• two/);
});

test("renders fenced code block with code content", () => {
  const { lastFrame } = render(
    <MarkdownText text={"```bash\npytest -q\n```"} theme={THEMES.graphite} />,
  );
  assert.match(lastFrame() ?? "", /pytest -q/);
});
