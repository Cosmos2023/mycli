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
import { reduceShellState } from "../src/state/reducer.ts";
import type { ShellState } from "../src/state/types.ts";

const state: ShellState = {
  sessionId: "demo",
  sessionTitle: null,
  workspace: "/repo",
  model: "deepseek-v4",
  provider: "deepseek/chat_completions",
  trust: { state: "trusted", workspace: "/repo", source: "test", enforced: true },
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
  assert.match(frame, /✓ Read pyproject\.toml/);
  assert.match(frame, /Project is mycli/);
  assert.doesNotMatch(frame, /Turn|\[assistant\]|\[tools\]|USER|ASSISTANT|TOOL/);
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

test("transcript renders bounded diagnostic detail when present", () => {
  const { lastFrame } = render(
    <Transcript
      state={{
        ...state,
        transcript: [
          {
            id: "e1",
            type: "error",
            text: "Request failed.",
            folded: false,
            metadata: {
              source: "request",
              method: "session.bootstrap",
              code: "request_failed",
              detail: "Gateway startup failed because /dev/tty is unavailable in this process",
            },
          },
        ],
      }}
    />,
  );
  const frame = lastFrame() ?? "";

  assert.match(frame, /detail=Gateway startup failed/);
  assert.doesNotMatch(frame, /at RuntimeApp/);
});

test("status line renders compact metadata and context usage", () => {
  const { lastFrame } = render(<StatusLine state={state} />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /session: demo/);
  assert.match(frame, /model: deepseek-v4/);
  assert.match(frame, /theme: deep-teal/);
  assert.match(frame, /ctx: 4% 3,983\/100k/);
});

test("overlay renders command lines", () => {
  const { lastFrame } = render(<Overlay overlay={state.overlay} theme={state.theme} />);
  assert.match(lastFrame() ?? "", /\/usage/);
  assert.match(lastFrame() ?? "", /turns=1/);
});

test("app gives overlay priority over workspace trust prompt", () => {
  const { lastFrame } = render(
    <App
      state={{
        ...state,
        trust: { state: "unknown", workspace: "/repo", enforced: false },
        overlay: { visible: true, title: "/help", lines: ["Input", "Commands"] },
      }}
      width={80}
    />,
  );
  const frame = lastFrame() ?? "";

  assert.match(frame, /\/help/);
  assert.match(frame, /Commands/);
  assert.doesNotMatch(frame, /Workspace trust/);
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
          tool_id: "call_question_1",
          call_id: "call_question_1",
          tool_name: "AskUserQuestion",
          question: "Which slice should come next?",
          options: [{ label: "Runtime" }, { label: "TUI" }],
          multi_select: false,
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
          tool_id: "call_question_1",
          call_id: "call_question_1",
          tool_name: "AskUserQuestion",
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
          tool_id: "call_question_1",
          call_id: "call_question_1",
          tool_name: "AskUserQuestion",
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
          tool_id: "call_question_1",
          call_id: "call_question_1",
          tool_name: "AskUserQuestion",
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
  assert.deepEqual(localActions.filter((type) => type === "command.result"), ["command.result"]);
});

test("app suggests nearest catalog command for unknown slash command", () => {
  const commands: string[] = [];
  const localActions: string[] = [];
  const { stdin } = render(
    <App
      state={state}
      onCommand={(command) => commands.push(command)}
      onLocalAction={(action) => localActions.push(`${action.type}:${"command" in action ? action.command : ""}`)}
    />,
  );

  stdin.write("/trst");
  stdin.write("\r");

  assert.deepEqual(commands, []);
  assert.deepEqual(
    localActions.filter((action) => action.startsWith("command.result")),
    ["command.result:/trst"],
  );
});

test("app accepts slash completion and routes selected runtime command", () => {
  const commands: string[] = [];
  let liveState: ShellState = { ...state, overlay: { visible: false, title: "", lines: [] } };
  const renderApp = () => (
    <App
      state={liveState}
      onCommand={(command) => commands.push(command)}
      onLocalAction={(action) => {
        liveState = reduceShellState(liveState, action);
        rerender(renderApp());
      }}
    />
  );
  const { stdin, rerender } = render(renderApp());

  stdin.write("/sta");
  stdin.write("\t");
  stdin.write("\r");

  assert.deepEqual(commands, ["/status"]);
});

test("app Ctrl-C closes overlay before interrupting a turn", () => {
  const localActions: string[] = [];
  const interrupts: string[] = [];
  const { stdin } = render(
    <App
      state={{ ...state, turnRunning: true, overlay: { visible: true, title: "/logs", lines: [] } }}
      onLocalAction={(action) => localActions.push(action.type)}
      onInterrupt={() => interrupts.push("interrupt")}
    />,
  );

  stdin.write("\u0003");

  assert.deepEqual(localActions, ["overlay.closed"]);
  assert.deepEqual(interrupts, []);
});

test("app Ctrl-C clears draft before exiting", () => {
  const localActions: string[] = [];
  const exits: string[] = [];
  const { stdin } = render(
    <App
      state={{ ...state, overlay: { visible: false, title: "", lines: [] }, inputDraft: "hello" }}
      onLocalAction={(action) => localActions.push(action.type)}
      onExit={() => exits.push("exit")}
    />,
  );

  stdin.write("\u0003");

  assert.deepEqual(localActions, ["input.cleared"]);
  assert.deepEqual(exits, []);
});

test("app Ctrl-C interrupts running turns and exits only when idle", () => {
  const interrupts: string[] = [];
  const running = render(
    <App
      state={{ ...state, overlay: { visible: false, title: "", lines: [] }, turnRunning: true }}
      onInterrupt={() => interrupts.push("interrupt")}
    />,
  );

  running.stdin.write("\u0003");

  assert.deepEqual(interrupts, ["interrupt"]);

  const exits: string[] = [];
  const idle = render(
    <App state={{ ...state, overlay: { visible: false, title: "", lines: [] } }} onExit={() => exits.push("exit")} />,
  );

  idle.stdin.write("\u0003");

  assert.deepEqual(exits, ["exit"]);
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
        tool_id: "call_question_1",
        call_id: "call_question_1",
        tool_name: "AskUserQuestion",
        question: "Which slice should come next?",
        options: [],
        multi_select: false,
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
