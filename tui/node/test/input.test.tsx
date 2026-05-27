import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { InputBox } from "../src/app/InputBox.tsx";
import { initialState } from "../src/state/reducer.ts";

test("input submits non-empty message and clears draft", () => {
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

  stdin.write("hello");
  stdin.write("\r");

  assert.deepEqual(submitted, ["hello"]);
  assert.doesNotMatch(lastFrame() ?? "", /hello/);
});
