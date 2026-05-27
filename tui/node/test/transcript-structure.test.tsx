import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { AssistantBlock } from "../src/app/AssistantBlock.tsx";
import { Transcript } from "../src/app/Transcript.tsx";
import { UserPromptRow } from "../src/app/UserPromptRow.tsx";
import { initialState } from "../src/state/reducer.ts";

test("user prompt row uses an accent prompt marker without role label", () => {
  const state = initialState({ rawThemeName: "deep-teal" });
  const { lastFrame } = render(<UserPromptRow text="你是谁" theme={state.theme} width={80} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /› 你是谁/);
  assert.doesNotMatch(frame, /USER/);
});

test("assistant block renders bounded text with a left rail", () => {
  const state = initialState({ rawThemeName: "graphite" });
  const text =
    "我是 mycli，一个运行在你本地机器上的编程助手。我可以读写文件、执行命令、搜索代码、管理任务计划。";
  const { lastFrame } = render(
    <AssistantBlock text={text} final={true} theme={state.theme} width={72} />,
  );
  const frame = lastFrame() ?? "";

  assert.match(frame, /│/);
  assert.match(frame, /我是 mycli/);
  assert.doesNotMatch(frame, /ASSISTANT/);
});

test("transcript routes user and assistant rows through structured components", () => {
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

  assert.match(frame, /› 你是谁/);
  assert.match(frame, /│/);
  assert.match(frame, /mycli\.cli\.main:main/);
  assert.doesNotMatch(frame, /USER|ASSISTANT|TOOL/);
});
