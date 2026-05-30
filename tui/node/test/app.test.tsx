import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { Overlay } from "../src/app/Overlay.tsx";
import { App, inputHint } from "../src/app/App.tsx";
import { ClarificationRow } from "../src/app/ClarificationRow.tsx";
import { StatusLine } from "../src/app/StatusLine.tsx";
import { Transcript } from "../src/app/Transcript.tsx";
import { THEMES } from "../src/theme/themes.ts";
import type { ShellState } from "../src/state/types.ts";

const state: ShellState = {
  sessionId: "demo",
  workspace: "/repo",
  model: "deepseek-v4",
  provider: "deepseek/chat_completions",
  status: { context_window: { used_tokens: 3983, max_tokens: 100000 } },
  themeName: "deep-teal",
  theme: THEMES["deep-teal"],
  themeNotice: null,
  transcript: [
    { id: "u1", type: "user", text: "read pyproject", folded: false, metadata: {} },
    {
      id: "t1",
      type: "tool_summary",
      text: "Read pyproject.toml",
      folded: true,
      metadata: { tool_name: "Read", path: "pyproject.toml" },
    },
    { id: "a1", type: "assistant_final", text: "Project is mycli.", folded: false, metadata: {} },
  ],
  inputDraft: "",
  restoredDraft: "",
  turnRunning: false,
  currentTurnId: null,
  liveStatus: null,
  liveReasoning: null,
  typedMessageTurnId: null,
  viewMode: "default",
  completion: { visible: false, requestId: 0, prefix: "", items: [], selectedIndex: 0 },
  overlay: { visible: true, title: "/usage", lines: ["turns=1"] },
  pendingApproval: null,
  pendingClarification: null,
};

test("transcript renders user, folded tool summary, and answer without role cards", () => {
  const { lastFrame } = render(<Transcript state={state} />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /❯ read pyproject/);
  assert.match(frame, /● Read pyproject\.toml/);
  assert.match(frame, /Project is mycli/);
  assert.doesNotMatch(frame, /USER|ASSISTANT|TOOL/);
  assert.doesNotMatch(frame, /│/);
});

test("transcript renders compact diagnostics for request and gateway errors", () => {
  const { lastFrame } = render(
    <Transcript
      state={{
        ...state,
        transcript: [
          { id: "sys1", type: "system_notice", text: "mycli ready", folded: false, metadata: {} },
          { id: "u1", type: "user", text: "approve", folded: false, metadata: {} },
          {
            id: "e1",
            type: "error",
            text: "No pending decision.",
            folded: false,
            metadata: {
              source: "request",
              method: "approval.respond",
              code: "decision_not_pending",
            },
          },
          {
            id: "e2",
            type: "error",
            text: "Internal gateway error.",
            folded: false,
            metadata: {
              method: "command.run",
              code: "internal_error",
            },
          },
        ],
      }}
    />,
  );

  const frame = lastFrame() ?? "";
  assert.match(frame, /mycli ready/);
  assert.doesNotMatch(frame, /source=system/);
  assert.match(frame, /No pending decision/);
  assert.match(frame, /source=request · method=approval\.respond · code=decision_not_pending/);
  assert.match(frame, /Internal gateway error/);
  assert.match(frame, /method=command\.run · code=internal_error/);
});

test("status line renders compact metadata and context usage", () => {
  const { lastFrame } = render(<StatusLine state={state} />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /demo/);
  assert.match(frame, /deepseek-v4/);
  assert.match(frame, /deep-teal/);
  assert.match(frame, /4% 3,983\/100k/);
});

test("overlay renders command lines", () => {
  const { lastFrame } = render(<Overlay overlay={state.overlay} theme={state.theme} />);
  assert.match(lastFrame() ?? "", /\/usage/);
  assert.match(lastFrame() ?? "", /turns=1/);
});

test("app routes normal submit to clarification response while clarification is pending", () => {
  const submitted: string[] = [];
  const clarifications: Array<[string, string]> = [];
  const { stdin } = render(
    <App
      state={{
        ...state,
        pendingClarification: {
          request_id: "call_question_1",
          question: "Which slice should come next?",
          options: [{ label: "Runtime" }, { label: "TUI" }],
        },
      }}
      onSubmit={(value) => submitted.push(value)}
      onClarification={(requestId, response) => clarifications.push([requestId, response])}
    />,
  );

  stdin.write("Runtime");
  stdin.write("\r");

  assert.deepEqual(submitted, []);
  assert.deepEqual(clarifications, [["call_question_1", "Runtime"]]);
});

test("app maps numeric clarification input to option labels", () => {
  const clarifications: Array<[string, string]> = [];
  const { stdin } = render(
    <App
      state={{
        ...state,
        pendingClarification: {
          request_id: "call_question_1",
          question: "Which slice should come next?",
          options: [{ label: "Runtime" }, { label: "TUI" }],
          multi_select: false,
        },
      }}
      onClarification={(requestId, response) => clarifications.push([requestId, response])}
    />,
  );

  stdin.write("2");
  stdin.write("\r");

  assert.deepEqual(clarifications, [["call_question_1", "TUI"]]);
});

test("app maps case-insensitive clarification labels and preserves free-form answers", () => {
  const clarifications: Array<[string, string]> = [];
  const renderResult = render(
    <App
      state={{
        ...state,
        pendingClarification: {
          request_id: "call_question_1",
          question: "Which slice should come next?",
          options: [{ label: "Runtime" }, { label: "TUI" }],
          multi_select: false,
        },
      }}
      onClarification={(requestId, response) => clarifications.push([requestId, response])}
    />,
  );

  renderResult.stdin.write("tui");
  renderResult.stdin.write("\r");
  renderResult.stdin.write("ship both");
  renderResult.stdin.write("\r");

  assert.deepEqual(clarifications, [
    ["call_question_1", "TUI"],
    ["call_question_1", "ship both"],
  ]);
});

test("app keeps slash commands routed as commands while clarification is pending", () => {
  const commands: string[] = [];
  const clarifications: Array<[string, string]> = [];
  const { stdin } = render(
    <App
      state={{
        ...state,
        pendingClarification: {
          request_id: "call_question_1",
          question: "Which slice should come next?",
          options: [{ label: "Runtime" }, { label: "TUI" }],
          multi_select: false,
        },
      }}
      onCommand={(command) => commands.push(command)}
      onClarification={(requestId, response) => clarifications.push([requestId, response])}
    />,
  );

  stdin.write("/resume");
  stdin.write("\r");

  assert.deepEqual(commands, ["/resume"]);
  assert.deepEqual(clarifications, []);
});

test("app handles help locally without command.run", () => {
  const commands: string[] = [];
  const localActions: string[] = [];
  const { stdin } = render(
    <App
      state={state}
      onCommand={(command) => commands.push(command)}
      onLocalAction={(action) => localActions.push(action.type)}
    />,
  );

  stdin.write("/help");
  stdin.write("\r");

  assert.deepEqual(commands, []);
  assert.deepEqual(localActions, ["command.result"]);
});

test("app input hint follows the current interaction mode", () => {
  assert.equal(inputHint(state), "Enter send · / commands · Ctrl-C interrupt");
  assert.equal(
    inputHint({ ...state, turnRunning: true }),
    "Running · Ctrl-C interrupt",
  );
  assert.equal(
    inputHint({
      ...state,
      pendingClarification: {
        request_id: "call_question_1",
        question: "Which slice should come next?",
      },
    }),
    "Type a reply · Enter send · / for commands",
  );
  assert.equal(
    inputHint({
      ...state,
      pendingApproval: {
        decision_id: "decision_current",
        preview: "git push",
        options: [{ choice: "approve_once", label: "Allow once" }],
      },
    }),
    "Press 1-9 to respond · Ctrl-C interrupt",
  );
  assert.equal(
    inputHint({
      ...state,
      turnRunning: true,
      completion: { visible: true, requestId: 1, prefix: "/", items: [], selectedIndex: 0 },
    }),
    "↑/↓ move · Tab accept · Esc cancel",
  );
});

test("clarification row renders numbered option hint", () => {
  const { lastFrame } = render(
    <ClarificationRow
      item={{
        id: "clarify_1",
        type: "clarification",
        text: "Which slice should come next?",
        folded: false,
        metadata: {
          header: "Scope",
          options: [{ label: "Runtime" }, { label: "TUI" }],
        },
      }}
      theme={state.theme}
    />,
  );

  const frame = lastFrame() ?? "";
  assert.match(frame, /1\. Runtime/);
  assert.match(frame, /2\. TUI/);
  assert.match(frame, /Type 1-2, an option label, or a custom answer\./);
});
