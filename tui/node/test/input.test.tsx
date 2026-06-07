import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { InputBox, inputPreview } from "../src/app/InputBox.tsx";
import { initialState } from "../src/state/reducer.ts";

test("input submits non-empty message and clears draft", () => {
  const submitted: string[] = [];
  const { stdin, lastFrame } = render(
    <InputBox
      draft=""
      turnRunning={false}
      completionVisible={false}
      theme={initialState().theme}
      metadata="sess: default · model: deepseek-v4 · theme: deep-teal · ctx: 9% 9,302/100k"
      hint="Enter send · / commands · Ctrl-C interrupt"
      width={80}
      onDraftChange={() => undefined}
      onSubmit={(value) => submitted.push(value)}
      onInterrupt={() => undefined}
    />,
  );

  stdin.write("hello");
  stdin.write("\r");

  assert.deepEqual(submitted, ["hello"]);
  const frame = lastFrame() ?? "";
  assert.doesNotMatch(frame, /hello/);
  assert.match(frame, /Enter send/);
  assert.match(frame, /sess: default/);
  assert.match(frame, /ctx: 9% 9,302\/100k/);
  assert.doesNotMatch(frame, /sess: …/);
});

test("combined text plus return input submits instead of becoming paste", () => {
  const submitted: string[] = [];
  const { stdin, lastFrame } = render(
    <InputBox
      draft=""
      turnRunning={false}
      completionVisible={false}
      theme={initialState().theme}
      onDraftChange={() => undefined}
      onSubmit={(value) => submitted.push(value)}
      onInterrupt={() => undefined}
    />,
  );

  stdin.write("/help\r");

  assert.deepEqual(submitted, ["/help"]);
  assert.doesNotMatch(lastFrame() ?? "", /paste:/);
});

test("large draft input is retained without auto-submit", () => {
  const drafts: string[] = [];
  const submitted: string[] = [];
  const pasted = "x".repeat(300);
  const { stdin } = render(
    <InputBox
      draft=""
      turnRunning={false}
      completionVisible={false}
      theme={initialState().theme}
      onDraftChange={(value) => drafts.push(value)}
      onSubmit={(value) => submitted.push(value)}
      onInterrupt={() => undefined}
    />,
  );

  stdin.write(pasted);

  assert.deepEqual(submitted, []);
  assert.equal(drafts.at(-1), pasted);
});

test("large controlled draft is collapsed in the input preview", () => {
  const { lastFrame } = render(
    <InputBox
      draft={"x".repeat(300)}
      turnRunning={false}
      completionVisible={false}
      theme={initialState().theme}
      onDraftChange={() => undefined}
      onSubmit={() => undefined}
      onInterrupt={() => undefined}
    />,
  );

  assert.match(lastFrame() ?? "", /paste: 1 line, 300 chars collapsed/);
});

test("inputPreview collapses multi-line paste diagnostics", () => {
  const preview = inputPreview("line one\nline two\nline three", 80);

  assert.equal(preview.text, "line one");
  assert.equal(preview.diagnostic, "paste: 3 lines, 28 chars collapsed");
});
