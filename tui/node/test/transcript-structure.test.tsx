import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { AssistantBlock } from "../src/app/AssistantBlock.tsx";
import { Transcript } from "../src/app/Transcript.tsx";
import { UserPromptRow } from "../src/app/UserPromptRow.tsx";
import { initialState } from "../src/state/reducer.ts";

test("user prompt row uses Claude-style marker without role label", () => {
  const state = initialState({ rawThemeName: "deep-teal" });
  const { lastFrame } = render(<UserPromptRow text="你是谁" theme={state.theme} width={80} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /❯ 你是谁/);
  assert.doesNotMatch(frame, /USER/);
});

test("assistant block renders bounded text without a left rail", () => {
  const state = initialState({ rawThemeName: "graphite" });
  const text =
    "我是 mycli，一个运行在你本地机器上的编程助手。我可以读写文件、执行命令、搜索代码、管理任务计划。";
  const { lastFrame } = render(
    <AssistantBlock text={text} final={true} theme={state.theme} width={72} />,
  );
  const frame = lastFrame() ?? "";

  assert.match(frame, /我是 mycli/);
  assert.doesNotMatch(frame, /│/);
  assert.doesNotMatch(frame, /ASSISTANT/);
});

test("assistant stream shows active cursor", () => {
  const state = initialState({ rawThemeName: "deep-teal" });
  const { lastFrame } = render(
    <AssistantBlock text="正在回答" final={false} theme={state.theme} width={80} />,
  );
  const frame = lastFrame() ?? "";

  assert.match(frame, /正在回答▍/);
});

test("transcript routes user and assistant rows through Claude-style components", () => {
  const state = {
    ...initialState({ rawThemeName: "mono" }),
    transcript: [
      { id: "u1", type: "user" as const, text: "你是谁", folded: false, metadata: {} },
      {
        id: "a1",
        type: "assistant_final" as const,
        text: "我是 **mycli**，入口是 `mycli.cli.main:main`。",
        folded: false,
        metadata: {},
      },
    ],
  };

  const { lastFrame } = render(<Transcript state={state} width={80} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /❯ 你是谁/);
  assert.match(frame, /mycli\.cli\.main:main/);
  assert.doesNotMatch(frame, /Turn|\[assistant\]|\[tools\]|USER|ASSISTANT|TOOL/);
});

test("transcript renders clarification request with options", () => {
  const state = {
    ...initialState({ rawThemeName: "deep-teal" }),
    transcript: [
      { id: "u1", type: "user" as const, text: "继续", folded: false, metadata: {} },
      {
        id: "q1",
        type: "clarification" as const,
        text: "Which slice should come next?",
        folded: false,
        metadata: {
          header: "Scope",
          options: [
            { label: "Runtime", description: "Only runtime contract" },
            { label: "TUI", description: "Render the request" },
          ],
        },
      },
    ],
  };

  const { lastFrame } = render(<Transcript state={state} width={80} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /Scope/);
  assert.match(frame, /Which slice should come next\?/);
  assert.match(frame, /Runtime/);
  assert.match(frame, /Only runtime contract/);
  assert.match(frame, /TUI/);
  assert.doesNotMatch(frame, /Approval required/);
  assert.doesNotMatch(frame, /Press a number/);
});
