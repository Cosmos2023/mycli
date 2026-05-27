# Node TUI Current Turn Focus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the Node Ink TUI transcript into a Claude-Code-like continuous console: prior turns remain visible, noisy internals collapse, tools render before answers with `●`, expanded tool results use `⎿`, user turns use `❯`, streaming text uses `▍`, and the bottom input/statusline becomes minimal.

**Architecture:** Keep Python as the runtime/session/tool/model authority and keep the reducer's flat `state.transcript` as the source of truth. Add a pure Node display model that derives `{prelude, turns}` from transcript items, then render turns through focused row components without changing JSON-RPC, session persistence, tool execution, approvals, prompts, or provider behavior.

**Tech Stack:** Python 3.13, pytest, ruff, mypy, Node.js >= 20, npm, TypeScript strict mode, React 19, Ink 6, Node `node:test`, `ink-testing-library`.

**Spec:** `docs/superpowers/specs/2026-05-27-node-tui-current-turn-focus.md`

---

## Implementation Decisions

- This is a Node UI slice. Do not modify Python gateway/protocol/session/tool/model/prompt code.
- Do not add dependencies.
- Do not add per-tool keyboard selection/expansion in this slice. `default` collapses raw tool detail; `verbose` expands detail globally.
- Keep existing local `/theme` and `/clear` behavior.
- Keep existing `ViewMode` values:
  - `default`: continuous transcript, raw tool details collapsed.
  - `verbose`: continuous transcript, tool details visible with `⎿`.
  - `focus`: current turn only.
- Use a pure display-model helper so tests can cover grouping/order without rendering Ink.
- Treat `tool_detail` items as attachable detail rows. Existing gateway events may not yet create many `tool_detail` rows; the renderer still supports them for transcript-loaded or future detail items.
- Leave true virtualization for a later slice. This plan uses a light static/dynamic split through memoized completed turn components and stable keys.

## File Structure

- Create `tui/node/src/app/displayModel.ts`: pure grouping and turn-selection helpers.
- Create `tui/node/test/display-model.test.ts`: deterministic display model tests.
- Modify `tui/node/src/app/UserPromptRow.tsx`: switch transcript user marker from `›` to `❯`.
- Modify `tui/node/src/app/AssistantBlock.tsx`: remove left rail, add optional streaming cursor.
- Modify `tui/node/src/app/ToolRow.tsx`: switch from aligned table row to `● Verb target · detail`.
- Create `tui/node/src/app/ToolResultRow.tsx`: render verbose `⎿` tool details.
- Create `tui/node/src/app/TurnSeparator.tsx`: dim separator between visible completed turns.
- Modify `tui/node/src/app/RunningActivity.tsx`: render `● Thinking ...` and allow inline turn placement.
- Modify `tui/node/src/app/Transcript.tsx`: render grouped turns and view modes.
- Modify `tui/node/src/app/InputBox.tsx`: remove placeholder, switch input prompt to `>`, move metadata below input.
- Modify `tui/node/src/app/StatusLine.tsx`: include model in bottom metadata and keep compact status string.
- Modify `tui/node/src/app/Header.tsx`: keep only brand + workspace in header.
- Modify/update Node tests:
  - `tui/node/test/transcript-structure.test.tsx`
  - `tui/node/test/tool-activity.test.tsx`
  - `tui/node/test/command-bar.test.tsx`
  - `tui/node/test/header-welcome.test.tsx`
  - `tui/node/test/app-visual-structure.test.tsx`
- Create `docs/superpowers/reports/2026-05-28-node-tui-current-turn-focus-smoke.md`: final verification report.

---

### Task 1: Display Turn Model

**Files:**
- Create: `tui/node/src/app/displayModel.ts`
- Create: `tui/node/test/display-model.test.ts`

- [ ] **Step 1: Write failing display-model tests**

Create `tui/node/test/display-model.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  currentTurn,
  groupTranscriptIntoTurns,
  visibleTurnsForMode,
} from "../src/app/displayModel.ts";
import type { TranscriptItem } from "../src/state/types.ts";

function item(
  id: string,
  type: TranscriptItem["type"],
  text: string,
  metadata: Record<string, unknown> = {},
): TranscriptItem {
  return { id, type, text, folded: false, metadata };
}

test("groupTranscriptIntoTurns returns prelude and starts a turn at each user item", () => {
  const grouped = groupTranscriptIntoTurns([
    item("w1", "system_notice", "welcome", { startup_mark: { name: "default" } }),
    item("u1", "user", "你是谁"),
    item("a1", "assistant_final", "我是 mycli"),
    item("u2", "user", "有哪些 skill"),
    item("t1", "tool_summary", "Read AGENTS.md", { tool_name: "Read", path: "AGENTS.md" }),
    item("d1", "tool_detail", "AGENTS content"),
    item("a2", "assistant_final", "两个 skill"),
  ]);

  assert.equal(grouped.prelude.length, 1);
  assert.equal(grouped.turns.length, 2);
  assert.equal(grouped.turns[0]?.user?.text, "你是谁");
  assert.equal(grouped.turns[0]?.assistantFinal?.text, "我是 mycli");
  assert.equal(grouped.turns[1]?.tools.length, 1);
  assert.equal(grouped.turns[1]?.toolDetails.length, 1);
});

test("items before the first user stay in prelude", () => {
  const grouped = groupTranscriptIntoTurns([
    item("n1", "command_output", "Theme changed"),
    item("u1", "user", "hello"),
    item("a1", "assistant_final", "hi"),
  ]);

  assert.deepEqual(grouped.prelude.map((entry) => entry.id), ["n1"]);
  assert.deepEqual(grouped.turns.map((turn) => turn.id), ["turn_u1"]);
});

test("currentTurn returns the last grouped turn", () => {
  const grouped = groupTranscriptIntoTurns([
    item("u1", "user", "one"),
    item("a1", "assistant_final", "answer one"),
    item("u2", "user", "two"),
  ]);

  assert.equal(currentTurn(grouped.turns)?.user?.text, "two");
});

test("visibleTurnsForMode keeps prior turns in default and verbose but only current in focus", () => {
  const grouped = groupTranscriptIntoTurns([
    item("u1", "user", "one"),
    item("a1", "assistant_final", "answer one"),
    item("u2", "user", "two"),
    item("a2", "assistant_final", "answer two"),
  ]);

  assert.deepEqual(visibleTurnsForMode(grouped.turns, "default").map((turn) => turn.id), [
    "turn_u1",
    "turn_u2",
  ]);
  assert.deepEqual(visibleTurnsForMode(grouped.turns, "verbose").map((turn) => turn.id), [
    "turn_u1",
    "turn_u2",
  ]);
  assert.deepEqual(visibleTurnsForMode(grouped.turns, "focus").map((turn) => turn.id), [
    "turn_u2",
  ]);
});
```

- [ ] **Step 2: Run failing display-model tests**

Run:

```bash
npm --prefix tui/node test -- test/display-model.test.ts
```

Expected: FAIL because `tui/node/src/app/displayModel.ts` does not exist.

- [ ] **Step 3: Add display model helper**

Create `tui/node/src/app/displayModel.ts`:

```ts
import type { ShellState, TranscriptItem } from "../state/types.ts";

export type DisplayTurn = {
  id: string;
  user: TranscriptItem | null;
  tools: TranscriptItem[];
  toolDetails: TranscriptItem[];
  statuses: TranscriptItem[];
  approvals: TranscriptItem[];
  assistantStream: TranscriptItem | null;
  assistantFinal: TranscriptItem | null;
  notices: TranscriptItem[];
  errors: TranscriptItem[];
};

export type GroupedTranscript = {
  prelude: TranscriptItem[];
  turns: DisplayTurn[];
};

function emptyTurn(user: TranscriptItem): DisplayTurn {
  return {
    id: `turn_${user.id}`,
    user,
    tools: [],
    toolDetails: [],
    statuses: [],
    approvals: [],
    assistantStream: null,
    assistantFinal: null,
    notices: [],
    errors: [],
  };
}

function appendToTurn(turn: DisplayTurn, item: TranscriptItem): DisplayTurn {
  if (item.type === "tool_summary") {
    return { ...turn, tools: [...turn.tools, item] };
  }
  if (item.type === "tool_detail") {
    return { ...turn, toolDetails: [...turn.toolDetails, item] };
  }
  if (item.type === "execution_status") {
    return { ...turn, statuses: [...turn.statuses, item] };
  }
  if (item.type === "approval") {
    return { ...turn, approvals: [...turn.approvals, item] };
  }
  if (item.type === "assistant_stream") {
    return { ...turn, assistantStream: item };
  }
  if (item.type === "assistant_final") {
    return { ...turn, assistantFinal: item, assistantStream: null };
  }
  if (item.type === "warning" || item.type === "error") {
    return { ...turn, errors: [...turn.errors, item] };
  }
  return { ...turn, notices: [...turn.notices, item] };
}

export function groupTranscriptIntoTurns(items: TranscriptItem[]): GroupedTranscript {
  const prelude: TranscriptItem[] = [];
  const turns: DisplayTurn[] = [];

  for (const item of items) {
    if (item.type === "user") {
      turns.push(emptyTurn(item));
      continue;
    }

    const last = turns.at(-1);
    if (!last) {
      prelude.push(item);
      continue;
    }

    turns[turns.length - 1] = appendToTurn(last, item);
  }

  return { prelude, turns };
}

export function currentTurn(turns: DisplayTurn[]): DisplayTurn | null {
  return turns.at(-1) ?? null;
}

export function visibleTurnsForMode(
  turns: DisplayTurn[],
  viewMode: ShellState["viewMode"],
): DisplayTurn[] {
  if (viewMode === "focus") {
    const current = currentTurn(turns);
    return current ? [current] : [];
  }
  return turns;
}

export function isStartupNotice(item: TranscriptItem): boolean {
  return item.type === "system_notice" && typeof item.metadata.startup_mark === "object";
}
```

- [ ] **Step 4: Run display-model tests**

Run:

```bash
npm --prefix tui/node test -- test/display-model.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run:

```bash
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tui/node/src/app/displayModel.ts tui/node/test/display-model.test.ts
git commit -m "Add Node TUI display turn model" \
  -m "The Claude-style transcript needs a pure display model that groups flat transcript items into visible turns without changing reducer or Python runtime state." \
  -m "Constraint: Grouping is Node display-only and does not add turn ids to the gateway protocol." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: npm --prefix tui/node test -- test/display-model.test.ts" \
  -m "Tested: npm --prefix tui/node run typecheck"
```

---

### Task 2: Claude-Style Row Components

**Files:**
- Modify: `tui/node/src/app/UserPromptRow.tsx`
- Modify: `tui/node/src/app/AssistantBlock.tsx`
- Modify: `tui/node/src/app/ToolRow.tsx`
- Create: `tui/node/src/app/ToolResultRow.tsx`
- Modify: `tui/node/src/app/RunningActivity.tsx`
- Modify: `tui/node/test/transcript-structure.test.tsx`
- Modify: `tui/node/test/tool-activity.test.tsx`

- [ ] **Step 1: Update failing row component tests**

Replace `tui/node/test/transcript-structure.test.tsx` with:

```tsx
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
  assert.doesNotMatch(frame, /│/);
  assert.doesNotMatch(frame, /USER|ASSISTANT|TOOL/);
});
```

Replace `tui/node/test/tool-activity.test.tsx` with:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { RunningActivity, activityPath } from "../src/app/RunningActivity.tsx";
import { ToolResultRow } from "../src/app/ToolResultRow.tsx";
import { ToolRow } from "../src/app/ToolRow.tsx";
import { initialState } from "../src/state/reducer.ts";

test("tool row renders Claude-style tool call summary", () => {
  const state = initialState({ rawThemeName: "deep-teal" });
  const { lastFrame } = render(
    <ToolRow
      summary={{ verb: "read", target: "pyproject.toml", status: "done", detail: "82ms" }}
      theme={state.theme}
      width={80}
    />,
  );
  const frame = lastFrame() ?? "";

  assert.match(frame, /● Read pyproject\.toml · 82ms/);
  assert.doesNotMatch(frame, /done 82ms/);
});

test("tool result row renders continuation marker", () => {
  const state = initialState({ rawThemeName: "graphite" });
  const { lastFrame } = render(<ToolResultRow text={"[project]\\nname = \"mycli\""} theme={state.theme} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /⎿ \[project\]/);
  assert.match(frame, /name = "mycli"/);
});

test("activity path derives compact recent tool path", () => {
  const state = {
    ...initialState({ rawThemeName: "mono" }),
    transcript: [
      {
        id: "t1",
        type: "tool_summary" as const,
        text: "Read pyproject.toml",
        folded: true,
        metadata: { tool_name: "Read", path: "pyproject.toml" },
      },
      {
        id: "t2",
        type: "tool_summary" as const,
        text: "Grep NodeTuiGateway",
        folded: true,
        metadata: { tool_name: "Grep", query: "NodeTuiGateway" },
      },
    ],
  };

  assert.equal(activityPath(state.transcript), "read → grep");
});

test("running activity line renders Claude-style thinking row", () => {
  const state = {
    ...initialState({ rawThemeName: "graphite" }),
    turnRunning: true,
    transcript: [
      {
        id: "t1",
        type: "tool_summary" as const,
        text: "Read pyproject.toml",
        folded: true,
        metadata: { tool_name: "Read", path: "pyproject.toml" },
      },
    ],
  };

  const { lastFrame } = render(<RunningActivity state={state} elapsedSeconds={12} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /● Thinking 12s · read/);
});
```

- [ ] **Step 2: Run failing row tests**

Run:

```bash
npm --prefix tui/node test -- test/transcript-structure.test.tsx test/tool-activity.test.tsx
```

Expected: FAIL because current rows still render `›`, assistant rail `│`, table-like tool rows, and lowercase `thinking`.

- [ ] **Step 3: Update user prompt row**

Replace `tui/node/src/app/UserPromptRow.tsx` with:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { contentWidth, DEFAULT_TERMINAL_WIDTH } from "./layout.ts";
import type { ThemeTokens } from "../theme/types.ts";

export function UserPromptRow({
  text,
  theme,
  width = DEFAULT_TERMINAL_WIDTH,
}: {
  text: string;
  theme: ThemeTokens;
  width?: number;
}) {
  return (
    <Box width={contentWidth(width) + 4}>
      <Text color={theme.accent} bold>
        ❯{" "}
      </Text>
      <Box width={contentWidth(width)}>
        <Text color={theme.text} bold>
          {text}
        </Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 4: Update assistant block**

Replace `tui/node/src/app/AssistantBlock.tsx` with:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { contentWidth, DEFAULT_TERMINAL_WIDTH } from "./layout.ts";
import { MarkdownText } from "./MarkdownText.tsx";
import type { ThemeTokens } from "../theme/types.ts";

export function AssistantBlock({
  text,
  final,
  theme,
  width = DEFAULT_TERMINAL_WIDTH,
}: {
  text: string;
  final: boolean;
  theme: ThemeTokens;
  width?: number;
}) {
  const columnWidth = contentWidth(width);
  return (
    <Box marginLeft={1} width={columnWidth} flexDirection="column">
      {final ? (
        <MarkdownText text={text} theme={theme} width={columnWidth} />
      ) : (
        <Text color={theme.text}>
          {text}
          <Text color={theme.accent}>▍</Text>
        </Text>
      )}
    </Box>
  );
}
```

- [ ] **Step 5: Update tool row**

Replace `tui/node/src/app/ToolRow.tsx` with:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { DEFAULT_TERMINAL_WIDTH, truncateMiddle } from "./layout.ts";
import type { ToolSummary } from "../state/toolSummary.ts";
import type { ThemeTokens } from "../theme/types.ts";

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function ToolRow({
  summary,
  theme,
  width = DEFAULT_TERMINAL_WIDTH,
}: {
  summary: ToolSummary;
  theme: ThemeTokens;
  width?: number;
}) {
  const markerColor =
    summary.status === "failed"
      ? theme.error
      : summary.status === "running"
        ? theme.warning
        : theme.accent;
  const targetWidth = width < 90 ? 42 : 64;
  const target = truncateMiddle(summary.target, targetWidth);
  const detail = summary.detail ? ` · ${summary.detail}` : "";

  return (
    <Box marginLeft={0}>
      <Text color={markerColor}>● </Text>
      <Text color={markerColor}>{titleCase(summary.verb)}</Text>
      <Text color={theme.muted}> {target}{detail}</Text>
    </Box>
  );
}
```

- [ ] **Step 6: Add tool result row**

Create `tui/node/src/app/ToolResultRow.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../theme/types.ts";

export function ToolResultRow({ text, theme }: { text: string; theme: ThemeTokens }) {
  const lines = text.split("\n");
  return (
    <Box flexDirection="column" marginLeft={0}>
      {lines.map((line, index) => (
        <Text key={`${index}:${line}`} color={theme.subtle}>
          {index === 0 ? "⎿ " : "  "}
          {line}
        </Text>
      ))}
    </Box>
  );
}
```

- [ ] **Step 7: Update running activity**

Replace `tui/node/src/app/RunningActivity.tsx` with:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { formatToolSummary } from "../state/toolSummary.ts";
import type { ShellState, TranscriptItem } from "../state/types.ts";

export function activityPath(items: TranscriptItem[]): string {
  const verbs = items
    .filter((item) => item.type === "tool_summary")
    .slice(-3)
    .map(
      (item) =>
        formatToolSummary({
          tool_name:
            item.metadata.tool_name ?? item.metadata.toolName ?? item.text.split(/\s+/, 1)[0],
          text: item.text,
          metadata: item.metadata,
        }).verb,
    );
  return verbs.join(" → ");
}

export function RunningActivity({
  state,
  elapsedSeconds = 0,
}: {
  state: ShellState;
  elapsedSeconds?: number;
}) {
  if (!state.turnRunning) {
    return null;
  }
  const path = activityPath(state.transcript);
  return (
    <Box marginLeft={0}>
      <Text color={state.theme.warning}>
        ● Thinking {elapsedSeconds}s{path ? ` · ${path}` : ""}
      </Text>
    </Box>
  );
}
```

- [ ] **Step 8: Run row tests and typecheck**

Run:

```bash
npm --prefix tui/node test -- test/transcript-structure.test.tsx test/tool-activity.test.tsx
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add tui/node/src/app/UserPromptRow.tsx tui/node/src/app/AssistantBlock.tsx tui/node/src/app/ToolRow.tsx tui/node/src/app/ToolResultRow.tsx tui/node/src/app/RunningActivity.tsx tui/node/test/transcript-structure.test.tsx tui/node/test/tool-activity.test.tsx
git commit -m "Render Node TUI rows with Claude-style tokens" \
  -m "User turns, tool calls, expanded tool results, and active streams now use the spec's visual token system while avoiding assistant role labels and left rails." \
  -m "Constraint: This changes Node rendering only; transcript data and Python runtime behavior are unchanged." \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: npm --prefix tui/node test -- test/transcript-structure.test.tsx test/tool-activity.test.tsx" \
  -m "Tested: npm --prefix tui/node run typecheck"
```

---

### Task 3: Grouped Transcript Rendering

**Files:**
- Modify: `tui/node/src/app/Transcript.tsx`
- Create: `tui/node/src/app/TurnSeparator.tsx`
- Create: `tui/node/test/current-turn-transcript.test.tsx`

- [ ] **Step 1: Write failing grouped transcript tests**

Create `tui/node/test/current-turn-transcript.test.tsx`:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { Transcript } from "../src/app/Transcript.tsx";
import { initialState } from "../src/state/reducer.ts";
import type { TranscriptItem } from "../src/state/types.ts";

function item(
  id: string,
  type: TranscriptItem["type"],
  text: string,
  metadata: Record<string, unknown> = {},
): TranscriptItem {
  return { id, type, text, folded: false, metadata };
}

test("default transcript keeps older turns visible and hides raw tool details", () => {
  const state = {
    ...initialState({ rawThemeName: "deep-teal" }),
    viewMode: "default" as const,
    transcript: [
      item("u1", "user", "你是谁"),
      item("a1", "assistant_final", "我是 mycli"),
      item("u2", "user", "你的系统提示词是什么"),
      item("t1", "tool_summary", "Read AGENTS.md", { tool_name: "Read", path: "AGENTS.md" }),
      item("d1", "tool_detail", "secret raw detail"),
      item("a2", "assistant_final", "核心是持续推进"),
    ],
  };

  const { lastFrame } = render(<Transcript state={state} width={80} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /❯ 你是谁/);
  assert.match(frame, /我是 mycli/);
  assert.match(frame, /❯ 你的系统提示词是什么/);
  assert.match(frame, /● Read AGENTS\.md/);
  assert.match(frame, /核心是持续推进/);
  assert.doesNotMatch(frame, /secret raw detail/);
  assert.doesNotMatch(frame, /Earlier turns collapsed/);
});

test("verbose transcript shows tool details with continuation marker", () => {
  const state = {
    ...initialState({ rawThemeName: "graphite" }),
    viewMode: "verbose" as const,
    transcript: [
      item("u1", "user", "读配置"),
      item("t1", "tool_summary", "Read pyproject.toml", { tool_name: "Read", path: "pyproject.toml" }),
      item("d1", "tool_detail", "[project]\nname = \"mycli\""),
      item("a1", "assistant_final", "已读取"),
    ],
  };

  const { lastFrame } = render(<Transcript state={state} width={80} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /● Read pyproject\.toml/);
  assert.match(frame, /⎿ \[project\]/);
  assert.match(frame, /name = "mycli"/);
});

test("focus transcript renders only the latest turn", () => {
  const state = {
    ...initialState({ rawThemeName: "mono" }),
    viewMode: "focus" as const,
    transcript: [
      item("u1", "user", "old"),
      item("a1", "assistant_final", "old answer"),
      item("u2", "user", "current"),
      item("a2", "assistant_final", "current answer"),
    ],
  };

  const { lastFrame } = render(<Transcript state={state} width={80} />);
  const frame = lastFrame() ?? "";

  assert.doesNotMatch(frame, /old answer/);
  assert.match(frame, /❯ current/);
  assert.match(frame, /current answer/);
});
```

- [ ] **Step 2: Run failing grouped transcript tests**

Run:

```bash
npm --prefix tui/node test -- test/current-turn-transcript.test.tsx
```

Expected: FAIL because `Transcript` still maps flat rows directly and does not render `tool_detail` with `⎿`.

- [ ] **Step 3: Add turn separator component**

Create `tui/node/src/app/TurnSeparator.tsx`:

```tsx
import React from "react";
import { Text } from "ink";
import { DEFAULT_TERMINAL_WIDTH } from "./layout.ts";
import type { ThemeTokens } from "../theme/types.ts";

export function TurnSeparator({
  theme,
  width = DEFAULT_TERMINAL_WIDTH,
}: {
  theme: ThemeTokens;
  width?: number;
}) {
  const dividerWidth = Math.max(24, Math.min(width, DEFAULT_TERMINAL_WIDTH));
  return <Text color={theme.border}>{"─".repeat(dividerWidth)}</Text>;
}
```

- [ ] **Step 4: Replace transcript renderer with grouped turns**

Replace `tui/node/src/app/Transcript.tsx` with:

```tsx
import React, { memo } from "react";
import { Box, Text } from "ink";
import { AssistantBlock } from "./AssistantBlock.tsx";
import { CommandOutput } from "./CommandOutput.tsx";
import {
  groupTranscriptIntoTurns,
  isStartupNotice,
  visibleTurnsForMode,
  type DisplayTurn,
} from "./displayModel.ts";
import { SystemNotice } from "./SystemNotice.tsx";
import { ToolResultRow } from "./ToolResultRow.tsx";
import { ToolRow } from "./ToolRow.tsx";
import { TurnSeparator } from "./TurnSeparator.tsx";
import { UserPromptRow } from "./UserPromptRow.tsx";
import { DEFAULT_TERMINAL_WIDTH } from "./layout.ts";
import { formatToolSummary } from "../state/toolSummary.ts";
import type { ThemeTokens } from "../theme/types.ts";
import type { ShellState, TranscriptItem } from "../state/types.ts";

function toolSummaryFor(item: TranscriptItem) {
  return formatToolSummary({
    tool_name: item.metadata.tool_name ?? item.metadata.toolName ?? item.text.split(/\s+/, 1)[0],
    text: item.text,
    metadata: item.metadata,
  });
}

const PreludeRow = memo(function PreludeRow({
  item,
  theme,
}: {
  item: TranscriptItem;
  theme: ThemeTokens;
}) {
  if (isStartupNotice(item)) {
    return null;
  }
  if (item.type === "command_output") {
    return <CommandOutput text={item.text} theme={theme} />;
  }
  if (item.type === "system_notice" || item.type === "warning" || item.type === "error") {
    return <SystemNotice text={item.text} type={item.type} theme={theme} />;
  }
  return (
    <Box>
      <Text dimColor>{item.text}</Text>
    </Box>
  );
});

const TurnView = memo(function TurnView({
  turn,
  theme,
  viewMode,
  width,
}: {
  turn: DisplayTurn;
  theme: ThemeTokens;
  viewMode: ShellState["viewMode"];
  width: number;
}) {
  const assistant = turn.assistantFinal ?? turn.assistantStream;
  return (
    <Box flexDirection="column">
      {turn.user ? <UserPromptRow text={turn.user.text} theme={theme} width={width} /> : null}
      {turn.approvals.map((item) => (
        <SystemNotice key={item.id} text={item.text} type="system_notice" theme={theme} />
      ))}
      {turn.tools.map((item) => (
        <ToolRow key={item.id} summary={toolSummaryFor(item)} theme={theme} width={width} />
      ))}
      {viewMode === "verbose"
        ? turn.toolDetails.map((item) => (
            <ToolResultRow key={item.id} text={item.text} theme={theme} />
          ))
        : null}
      {turn.statuses.map((item) => (
        <Text key={item.id} color={theme.subtle}>{item.text}</Text>
      ))}
      {assistant ? (
        <AssistantBlock
          text={assistant.text}
          final={assistant.type === "assistant_final"}
          theme={theme}
          width={width}
        />
      ) : null}
      {turn.notices.map((item) =>
        item.type === "command_output" ? (
          <CommandOutput key={item.id} text={item.text} theme={theme} />
        ) : (
          <SystemNotice key={item.id} text={item.text} type={item.type} theme={theme} />
        ),
      )}
      {turn.errors.map((item) => (
        <SystemNotice key={item.id} text={item.text} type={item.type} theme={theme} />
      ))}
    </Box>
  );
});

export function Transcript({
  state,
  width = DEFAULT_TERMINAL_WIDTH,
}: {
  state: ShellState;
  width?: number;
}) {
  const grouped = groupTranscriptIntoTurns(state.transcript);
  const turns = visibleTurnsForMode(grouped.turns, state.viewMode);

  return (
    <Box flexDirection="column" flexGrow={1}>
      {grouped.prelude.map((item) => (
        <PreludeRow key={item.id} item={item} theme={state.theme} />
      ))}
      {turns.map((turn, index) => (
        <Box key={turn.id} flexDirection="column">
          {index > 0 && state.viewMode !== "focus" ? (
            <TurnSeparator theme={state.theme} width={width} />
          ) : null}
          <TurnView
            turn={turn}
            theme={state.theme}
            viewMode={state.viewMode}
            width={width}
          />
        </Box>
      ))}
    </Box>
  );
}
```

- [ ] **Step 5: Run grouped transcript tests and existing transcript tests**

Run:

```bash
npm --prefix tui/node test -- test/display-model.test.ts test/current-turn-transcript.test.tsx test/transcript-structure.test.tsx test/transcript.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run typecheck**

Run:

```bash
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tui/node/src/app/Transcript.tsx tui/node/src/app/TurnSeparator.tsx tui/node/test/current-turn-transcript.test.tsx
git commit -m "Render Node TUI transcript by display turns" \
  -m "The transcript now derives display turns from the flat reducer state, keeps prior turns visible, hides raw tool details by default, and expands tool results in verbose mode." \
  -m "Constraint: The reducer remains flat and Python runtime state remains authoritative." \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: npm --prefix tui/node test -- test/display-model.test.ts test/current-turn-transcript.test.tsx test/transcript-structure.test.tsx test/transcript.test.ts" \
  -m "Tested: npm --prefix tui/node run typecheck"
```

---

### Task 4: Minimal Header, Input Row, And Bottom Statusline

**Files:**
- Modify: `tui/node/src/app/Header.tsx`
- Modify: `tui/node/src/app/InputBox.tsx`
- Modify: `tui/node/src/app/StatusLine.tsx`
- Modify: `tui/node/test/header-welcome.test.tsx`
- Modify: `tui/node/test/command-bar.test.tsx`
- Modify: `tui/node/test/status-input.test.tsx`
- Modify: `tui/node/test/input.test.tsx`

- [ ] **Step 1: Update failing header/input/status tests**

Replace `tui/node/test/command-bar.test.tsx` with:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { InputBox } from "../src/app/InputBox.tsx";
import { initialState } from "../src/state/reducer.ts";

test("input box renders minimal prompt and metadata below input", () => {
  const state = initialState({ rawThemeName: "graphite" });
  const { lastFrame } = render(
    <InputBox
      draft=""
      turnRunning={false}
      completionVisible={false}
      theme={state.theme}
      metadata="default · deepseek-v4-flash · graphite · 9% 9,302/100k"
      width={80}
      onDraftChange={() => undefined}
      onSubmit={() => undefined}
      onInterrupt={() => undefined}
    />,
  );
  const frame = lastFrame() ?? "";

  assert.match(frame, />/);
  assert.match(frame, /default · deepseek-v4-flash/);
  assert.doesNotMatch(frame, /Type a message or \/command/);
});

test("input box renders current draft next to prompt", () => {
  const state = initialState({ rawThemeName: "deep-teal" });
  const { lastFrame } = render(
    <InputBox
      draft="/usage"
      turnRunning={false}
      completionVisible={false}
      theme={state.theme}
      metadata="default · model"
      width={80}
      onDraftChange={() => undefined}
      onSubmit={() => undefined}
      onInterrupt={() => undefined}
    />,
  );
  const frame = lastFrame() ?? "";

  assert.match(frame, /> \/usage/);
  assert.doesNotMatch(frame, /local UI command or Python slash command/);
});
```

Update `tui/node/test/status-input.test.tsx` so the status metadata expectation includes model:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { StatusLine, statusMetadata } from "../src/app/StatusLine.tsx";
import { initialState } from "../src/state/reducer.ts";

test("status line renders compact session model theme and context", () => {
  const state = {
    ...initialState({ rawThemeName: "deep-teal" }),
    sessionId: "default",
    model: "deepseek/chat/deepseek-v4-flash",
    workspace: "/Users/cosmos/Desktop/mycli/.worktrees/fix-deepseek-cache-hit-rate",
    status: { context_window: { used_tokens: 9302, max_tokens: 100000 } },
  };

  const metadata = statusMetadata(state);
  assert.match(metadata, /default/);
  assert.match(metadata, /deepseek-v4-flash/);
  assert.match(metadata, /deep-teal/);
  assert.match(metadata, /9% 9,302\/100k/);

  const { lastFrame } = render(<StatusLine state={state} />);
  assert.match(lastFrame() ?? "", /deepseek-v4-flash/);
});
```

In `tui/node/test/header-welcome.test.tsx`, update the header assertion so it does not require model/context in the header:

```tsx
test("header band keeps brand and workspace inside compact width", () => {
  const state = {
    ...initialState({ rawThemeName: "graphite" }),
    sessionId: "default",
    workspace: "/Users/cosmos/Desktop/mycli/.worktrees/fix-deepseek-cache-hit-rate",
    model: "deepseek/chat/deepseek-v4-flash",
    status: { context_window: { used_tokens: 3983, max_tokens: 100000 } },
  };

  const { lastFrame } = render(<Header state={state} width={80} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /mycli/);
  assert.match(frame, /fix-de/);
  assert.doesNotMatch(frame, /deepseek-v4-flash/);
  assert.doesNotMatch(frame, /3,983\/100k/);
  assert.doesNotMatch(frame, /\.worktrees\/fix-deepseek-cache-hit-rate/);
});
```

- [ ] **Step 2: Run failing header/input/status tests**

Run:

```bash
npm --prefix tui/node test -- test/command-bar.test.tsx test/status-input.test.tsx test/header-welcome.test.tsx
```

Expected: FAIL because the input still shows placeholder/hints, status metadata lacks model/session, and header still shows model/context.

- [ ] **Step 3: Simplify header**

Replace `tui/node/src/app/Header.tsx` with:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { DEFAULT_TERMINAL_WIDTH, workspaceLabel } from "./layout.ts";
import type { ShellState } from "../state/types.ts";

export function Header({
  state,
  width = DEFAULT_TERMINAL_WIDTH,
}: {
  state: ShellState;
  width?: number;
}) {
  const workspace = workspaceLabel(state.workspace, width < 90 ? 30 : 44);
  const dividerWidth = Math.max(24, Math.min(width, DEFAULT_TERMINAL_WIDTH));

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={state.theme.accent} bold>
          mycli
        </Text>
        <Text color={state.theme.muted}>  {workspace}</Text>
      </Text>
      <Text color={state.theme.border}>{"─".repeat(dividerWidth)}</Text>
    </Box>
  );
}
```

- [ ] **Step 4: Update status metadata**

Replace `tui/node/src/app/StatusLine.tsx` with:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { formatContextUsage, modelLabel, truncateMiddle } from "./layout.ts";
import type { ShellState } from "../state/types.ts";

export function statusMetadata(state: ShellState): string {
  const session = state.sessionId ? truncateMiddle(state.sessionId, 18) : "pending";
  const model = modelLabel(state.model, 24);
  const parts = [session, model, state.themeName, formatContextUsage(state.status)];
  if (state.pendingApproval) {
    parts.push("approval pending");
  }
  return parts.join(" · ");
}

export function StatusLine({ state }: { state: ShellState }) {
  return (
    <Box>
      <Text color={state.theme.muted}>{statusMetadata(state)}</Text>
    </Box>
  );
}
```

- [ ] **Step 5: Update input box**

Replace `tui/node/src/app/InputBox.tsx` with:

```tsx
import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { DEFAULT_TERMINAL_WIDTH, truncateMiddle } from "./layout.ts";
import type { ThemeTokens } from "../theme/types.ts";

export function InputBox({
  draft,
  turnRunning,
  completionVisible,
  theme,
  metadata = "",
  width = DEFAULT_TERMINAL_WIDTH,
  onDraftChange,
  onSubmit,
  onInterrupt,
  onCompletionMove,
  onCompletionAccept,
  onCompletionClose,
}: {
  draft: string;
  turnRunning: boolean;
  completionVisible: boolean;
  theme: ThemeTokens;
  metadata?: string;
  width?: number;
  onDraftChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onInterrupt: () => void;
  onCompletionMove?: (delta: number) => void;
  onCompletionAccept?: () => void;
  onCompletionClose?: () => void;
}) {
  const [value, setValue] = useState(draft);
  const valueRef = useRef(draft);
  const updateValue = (next: string): void => {
    valueRef.current = next;
    setValue(next);
    onDraftChange(next);
  };
  const submitCurrentValue = (): void => {
    const submitted = valueRef.current.trim();
    if (submitted && !completionVisible) {
      onSubmit(submitted);
      updateValue("");
    }
  };
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onInterrupt();
      return;
    }
    if (completionVisible && key.downArrow) {
      onCompletionMove?.(1);
      return;
    }
    if (completionVisible && key.upArrow) {
      onCompletionMove?.(-1);
      return;
    }
    if (completionVisible && key.tab) {
      onCompletionAccept?.();
      return;
    }
    if (completionVisible && key.escape) {
      onCompletionClose?.();
      return;
    }
    if (key.return || input === "\r" || input === "\n") {
      submitCurrentValue();
      return;
    }
    if (key.backspace || key.delete) {
      updateValue(valueRef.current.slice(0, -1));
      return;
    }
    if (!key.ctrl && input) {
      const normalized = input.replaceAll("\r", "\n");
      const newlineIndex = normalized.indexOf("\n");
      const text = newlineIndex >= 0 ? normalized.slice(0, newlineIndex) : normalized;
      updateValue(`${valueRef.current}${text}`);
      if (newlineIndex >= 0) {
        submitCurrentValue();
      }
    }
  });

  const dividerWidth = Math.max(24, Math.min(width, DEFAULT_TERMINAL_WIDTH));
  const visibleMetadata = truncateMiddle(metadata, dividerWidth);
  return (
    <Box flexDirection="column">
      <Text color={theme.border}>{"─".repeat(dividerWidth)}</Text>
      <Text>
        <Text color={turnRunning ? theme.warning : theme.accent}>{">"}</Text>
        {value ? <Text color={theme.text}> {value}</Text> : null}
      </Text>
      <Text color={theme.subtle}>{visibleMetadata}</Text>
    </Box>
  );
}
```

- [ ] **Step 6: Run header/input/status tests**

Run:

```bash
npm --prefix tui/node test -- test/command-bar.test.tsx test/status-input.test.tsx test/header-welcome.test.tsx test/input.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Run typecheck**

Run:

```bash
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tui/node/src/app/Header.tsx tui/node/src/app/InputBox.tsx tui/node/src/app/StatusLine.tsx tui/node/test/command-bar.test.tsx tui/node/test/status-input.test.tsx tui/node/test/header-welcome.test.tsx tui/node/test/input.test.tsx
git commit -m "Simplify Node TUI header and bottom statusline" \
  -m "The Claude-style shell keeps brand/workspace in the header and moves session, model, theme, and context metadata below a minimal input prompt." \
  -m "Constraint: Input behavior stays the same; this changes presentation only." \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: npm --prefix tui/node test -- test/command-bar.test.tsx test/status-input.test.tsx test/header-welcome.test.tsx test/input.test.tsx" \
  -m "Tested: npm --prefix tui/node run typecheck"
```

---

### Task 5: Integrated Visual Structure Coverage

**Files:**
- Modify: `tui/node/test/app-visual-structure.test.tsx`
- Modify: `tui/node/test/app-polish.test.tsx`
- Modify: `tui/node/test/app.test.tsx`

- [ ] **Step 1: Update integrated app visual tests**

Replace `tui/node/test/app-visual-structure.test.tsx` with:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/app/App.tsx";
import { initialState } from "../src/state/reducer.ts";

test("app renders Claude-style continuous transcript anatomy", () => {
  const state = {
    ...initialState({ rawThemeName: "graphite" }),
    sessionId: "default",
    workspace: "/Users/cosmos/Desktop/mycli/.worktrees/fix-deepseek-cache-hit-rate",
    model: "deepseek/chat/deepseek-v4-flash",
    status: { context_window: { used_tokens: 9302, max_tokens: 100000 } },
    transcript: [
      { id: "u1", type: "user" as const, text: "你是谁", folded: false, metadata: {} },
      { id: "a1", type: "assistant_final" as const, text: "我是 mycli", folded: false, metadata: {} },
      { id: "u2", type: "user" as const, text: "读配置", folded: false, metadata: {} },
      {
        id: "t1",
        type: "tool_summary" as const,
        text: "Read pyproject.toml",
        folded: true,
        metadata: { tool_name: "Read", path: "pyproject.toml" },
      },
      { id: "d1", type: "tool_detail" as const, text: "raw config", folded: false, metadata: {} },
      { id: "a2", type: "assistant_final" as const, text: "已读取配置", folded: false, metadata: {} },
    ],
  };

  const { lastFrame } = render(<App state={state} width={80} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /mycli/);
  assert.match(frame, /fix-de/);
  assert.match(frame, /❯ 你是谁/);
  assert.match(frame, /我是 mycli/);
  assert.match(frame, /❯ 读配置/);
  assert.match(frame, /● Read pyproject\.toml/);
  assert.match(frame, />/);
  assert.match(frame, /default · deepseek-v4-flash · graphite · 9% 9,302\/100k/);
  assert.doesNotMatch(frame, /raw config/);
  assert.doesNotMatch(frame, /Type a message or \/command/);
  assert.doesNotMatch(frame, /USER|ASSISTANT/);
});
```

- [ ] **Step 2: Replace app polish test**

Replace `tui/node/test/app-polish.test.tsx` with:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/app/App.tsx";
import { initialState, reduceShellState } from "../src/state/reducer.ts";

test("app renders branded console anatomy", () => {
  let state = initialState({ rawThemeName: "deep-teal" });
  state = reduceShellState(state, {
    type: "bootstrap.result",
    payload: {
      session_id: "demo",
      workspace: "/repo/project",
      model: "deepseek-v4",
      provider: "deepseek/chat_completions",
      status: { context_window: { used_tokens: 3983, max_tokens: 100000 } },
      welcome: { startup_mark: { name: "default", text: "mycli" }, tips: ["/help"] },
    },
  });
  state = reduceShellState(state, { type: "user.submit", message: "read pyproject" });
  state = {
    ...state,
    transcript: [
      ...state.transcript,
      {
        id: "tool_1",
        type: "tool_summary",
        text: "Read pyproject.toml",
        folded: true,
        metadata: { tool_name: "Read", path: "pyproject.toml", duration_ms: 82 },
      },
      {
        id: "assistant_1",
        type: "assistant_final",
        text: "Project is **mycli** and entry is `mycli.cli.main:main`.",
        folded: false,
        metadata: {},
      },
    ],
  };

  const { lastFrame } = render(<App state={state} width={100} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /mycli/);
  assert.match(frame, /project/);
  assert.match(frame, /deepseek-v4/);
  assert.match(frame, /❯ read pyproject/);
  assert.match(frame, /● Read pyproject\.toml · 82ms/);
  assert.match(frame, /mycli\.cli\.main:main/);
  assert.match(frame, />/);
  assert.doesNotMatch(frame, /Type a message or \/command/);
  assert.doesNotMatch(frame, /USER|ASSISTANT|TOOL/);
  assert.doesNotMatch(frame, /│/);
});
```

- [ ] **Step 3: Replace app smoke-style component test**

Replace `tui/node/test/app.test.tsx` with:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { Overlay } from "../src/app/Overlay.tsx";
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
  viewMode: "default",
  completion: { visible: false, requestId: 0, prefix: "", items: [], selectedIndex: 0 },
  overlay: { visible: true, title: "/usage", lines: ["turns=1"] },
  pendingApproval: null,
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
```

- [ ] **Step 4: Run app visual tests**

Run:

```bash
npm --prefix tui/node test -- test/app-visual-structure.test.tsx test/app-polish.test.tsx test/app.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run full Node tests**

Run:

```bash
npm --prefix tui/node test
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tui/node/test/app-visual-structure.test.tsx tui/node/test/app-polish.test.tsx tui/node/test/app.test.tsx
git commit -m "Cover Claude-style Node TUI app anatomy" \
  -m "Integrated tests now lock the continuous transcript, Claude-style row tokens, folded tool details, minimal input prompt, and bottom statusline." \
  -m "Constraint: Tests cover presentation without changing gateway or reducer semantics." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: npm --prefix tui/node test" \
  -m "Tested: npm --prefix tui/node run typecheck"
```

---

### Task 6: Full Verification And Smoke Report

**Files:**
- Create: `docs/superpowers/reports/2026-05-28-node-tui-current-turn-focus-smoke.md`

- [ ] **Step 1: Run focused Python regression tests**

Run:

```bash
uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py -q
```

Expected: PASS.

- [ ] **Step 2: Run static checks and full Python suite**

Run:

```bash
uv run ruff check src tests
uv run mypy src/mycli
uv run pytest -q
```

Expected: PASS.

- [ ] **Step 3: Run full Node verification**

Run:

```bash
npm --prefix tui/node test
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run scripted Node TUI smoke**

Run:

```bash
SMOKE_HOME="$(mktemp -d)"
SESSION="node-tui-current-turn-focus-scripted-smoke-$(date +%Y%m%d%H%M%S)"
SCRIPT='["你是谁","你的系统提示词是什么","/theme graphite","/usage","/sessions","/clear","/quit"]'
HOME="$SMOKE_HOME" MYCLI_TUI_THEME=deep-teal MYCLI_NODE_TUI_SCRIPT="$SCRIPT" uv run mycli --node-tui --session "$SESSION"
```

Expected:

- exit code 0
- stderr contains `[node-tui] runtime.ready`
- stderr contains `[node-tui] turn.completed`
- stderr contains `Theme changed to graphite.`
- stderr contains `[usage]`
- stderr contains `[session]`
- stderr contains `Visible transcript cleared.`
- stderr contains `Bye.`
- stderr does not contain `Unknown command: /theme graphite`

- [ ] **Step 5: Run manual TTY smoke**

Run:

```bash
MYCLI_TUI_THEME=graphite uv run mycli --session node-tui-current-turn-focus-manual-smoke
```

Manual checklist:

```text
1. Header shows only mycli + workspace, not model/context.
2. Ask: 你是谁
3. Ask: 你有哪些 skill
4. Ask a tool-using prompt such as: 读一下 pyproject.toml 并总结项目入口
5. Confirm prior turns remain visible in default mode.
6. Confirm user prompts use ❯.
7. Confirm tool calls use ● and appear before the answer.
8. Confirm assistant prose has no │ left rail and no ASSISTANT label.
9. Confirm the input prompt is > with no placeholder text.
10. Confirm metadata appears below input with session/model/theme/context.
11. Run /view verbose and confirm tool detail rows use ⎿ when detail exists.
12. Run /theme deep-teal, /usage, /sessions, /clear, and /quit.
```

- [ ] **Step 6: Write smoke report**

Create `docs/superpowers/reports/2026-05-28-node-tui-current-turn-focus-smoke.md`:

```markdown
# Node TUI Current Turn Focus Smoke

## Scope

- Continuous Claude-style transcript.
- Prior turns visible in default mode.
- Raw tool details folded in default mode.
- `❯` user marker.
- `●` tool call marker.
- `⎿` verbose tool result marker.
- `▍` active stream cursor.
- Assistant prose without left rail or role label.
- Minimal `>` input prompt.
- Bottom runtime metadata below input.

## Verification

| Command | Result |
| --- | --- |
| `npm --prefix tui/node test` | PASS |
| `npm --prefix tui/node run typecheck` | PASS |
| `uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py -q` | PASS |
| `uv run ruff check src tests` | PASS |
| `uv run mypy src/mycli` | PASS |
| `uv run pytest -q` | PASS |
| scripted `MYCLI_NODE_TUI_SCRIPT` smoke | PASS |
| manual `MYCLI_TUI_THEME=graphite uv run mycli --session node-tui-current-turn-focus-manual-smoke` | PASS |

## Manual Notes

- Prior user prompts and assistant answers remained visible in default mode.
- Tool rows appeared before assistant answers.
- Raw tool detail stayed folded by default.
- Assistant prose rendered without `│` rail.
- Input rendered as `>` with no placeholder.
- Bottom metadata stayed below the input row.
- `/view verbose`, `/theme`, `/usage`, `/sessions`, `/clear`, and `/quit` remained functional.
```

After writing the report, replace each `PASS` in the table with exact counts where available, for example `PASS, 61 tests`.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/reports/2026-05-28-node-tui-current-turn-focus-smoke.md
git commit -m "Verify Node TUI current turn focus" \
  -m "The Claude-style continuous transcript is verified across Node tests, TypeScript, focused Python regressions, static checks, full pytest, scripted smoke, and manual TTY smoke." \
  -m "Constraint: Verification confirms the slice remains Node presentation-only." \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: npm --prefix tui/node test" \
  -m "Tested: npm --prefix tui/node run typecheck" \
  -m "Tested: uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py -q" \
  -m "Tested: uv run ruff check src tests" \
  -m "Tested: uv run mypy src/mycli" \
  -m "Tested: uv run pytest -q" \
  -m "Tested: scripted and manual Node TUI current turn focus smokes"
```

---

## Self-Review Checklist

- Spec coverage:
  - Continuous transcript: Task 1, Task 3, Task 5.
  - Prior turns visible: Task 1, Task 3, Task 5, Task 6.
  - Tool before answer: Task 3, Task 5.
  - `❯`, `●`, `⎿`, `▍`: Task 2, Task 3, Task 5.
  - Assistant without rail/card: Task 2, Task 5.
  - Minimal input and bottom metadata: Task 4, Task 5.
  - No Python/protocol changes: all tasks are Node UI/tests/docs.
- Placeholder scan: no unfinished markers or unspecified follow-up steps are allowed.
- Type consistency:
  - `DisplayTurn.assistantFinal` and `assistantStream` use camelCase.
  - `visibleTurnsForMode()` accepts `ShellState["viewMode"]`.
  - `ToolResultRow` receives raw `text` and `theme`.
  - `statusMetadata()` returns the string passed into `InputBox.metadata`.
