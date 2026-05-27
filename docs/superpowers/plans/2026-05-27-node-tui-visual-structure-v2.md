# Node TUI Visual Structure V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the Node Ink TUI main screen from a plain transcript into a visibly structured coding console with a stable header band, compact welcome surface, bounded assistant blocks, tool timeline rows, running activity, and bottom command bar.

**Architecture:** Keep Python as the runtime/session/tool/model authority and make all changes in the disposable Node UI layer. Add pure layout helpers and focused Ink row components, then wire them through the existing reducer-driven `ShellState` without changing JSON-RPC, Python gateway behavior, prompt construction, or session persistence.

**Tech Stack:** Python 3.13, pytest, ruff, mypy, Node.js >= 20, npm, TypeScript strict mode, React 19, Ink 6, Node `node:test`.

**Spec:** `docs/superpowers/specs/2026-05-27-node-tui-visual-structure-v2.md`

---

## Implementation Decisions

- Keep this slice Node-only. Do not modify Python runtime, gateway protocol, session persistence, tools, model calls, approvals, compaction, or prompts.
- Replace the visual role of `StatusLine` by moving compact metadata into `InputBox`. Keep `StatusLine.tsx` as a small compatibility component for existing tests and any future standalone use.
- Components that need deterministic width behavior accept an optional `width` prop. `App` passes a conservative default width first. This slice does not read real terminal columns.
- `WelcomePanel` renders the startup mark only while the transcript has no user, assistant, or tool rows. After conversation content appears, welcome is hidden rather than collapsed.
- Assistant stream and assistant final rows both use the left rail. Streaming remains plain text; final answers continue to use `MarkdownText`.
- Keep the existing theme tokens. Add no new dependencies.

## File Structure

- `tui/node/src/app/layout.ts`: pure layout helpers for truncation, labels, context usage, and content widths.
- `tui/node/test/layout.test.ts`: deterministic helper coverage.
- `tui/node/src/app/Header.tsx`: upgrade existing header into a width-aware header band.
- `tui/node/src/app/WelcomePanel.tsx`: display-only startup mark shown only before real conversation content.
- `tui/node/test/header-welcome.test.tsx`: header fitting and welcome visibility coverage.
- `tui/node/src/app/UserPromptRow.tsx`: focused user message row.
- `tui/node/src/app/AssistantBlock.tsx`: bounded assistant stream/final block with left rail.
- `tui/node/src/app/Transcript.tsx`: route transcript rows through focused components and hide welcome notices from raw transcript rendering.
- `tui/node/src/app/MarkdownText.tsx`: accept optional width and align with assistant block constraints.
- `tui/node/test/transcript-structure.test.tsx`: prompt row, assistant block, Chinese wrapping, and no role labels.
- `tui/node/src/app/ToolRow.tsx`: upgrade tool rows into aligned timeline telemetry.
- `tui/node/src/app/RunningActivity.tsx`: display running elapsed/path line from local transcript events.
- `tui/node/test/tool-activity.test.tsx`: timeline and running activity coverage.
- `tui/node/src/app/InputBox.tsx`: convert input/status into stable bottom command bar.
- `tui/node/src/app/StatusLine.tsx`: compact compatibility metadata line.
- `tui/node/src/app/App.tsx`: wire width, header, welcome, transcript, running activity, and command bar.
- `tui/node/test/command-bar.test.tsx`: command bar width and metadata elision coverage.
- `tui/node/test/app-visual-structure.test.tsx`: integrated V2 anatomy snapshot.
- `docs/superpowers/reports/2026-05-27-node-tui-visual-structure-v2-smoke.md`: final verification report.

---

### Task 1: Layout Helpers

**Files:**
- Create: `tui/node/src/app/layout.ts`
- Create: `tui/node/test/layout.test.ts`

- [ ] **Step 1: Write failing layout tests**

Create `tui/node/test/layout.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  contentWidth,
  formatContextUsage,
  modelLabel,
  truncateMiddle,
  workspaceLabel,
} from "../src/app/layout.ts";

test("truncateMiddle preserves short values and elides long values", () => {
  assert.equal(truncateMiddle("short", 10), "short");
  assert.equal(truncateMiddle("abcdefghijklmnopqrstuvwxyz", 12), "abcd…vwxyz");
  assert.equal(truncateMiddle("abcdefghijklmnopqrstuvwxyz", 5), "ab…yz");
});

test("workspaceLabel returns basename and truncates long basenames", () => {
  assert.equal(workspaceLabel("/repo/project", 20), "project");
  assert.equal(workspaceLabel("/repo/fix-deepseek-cache-hit-rate", 16), "fix-de…hit-rate");
  assert.equal(workspaceLabel("", 12), "workspace");
});

test("modelLabel strips provider-like prefixes and truncates", () => {
  assert.equal(modelLabel("deepseek/chat/deepseek-v4-flash", 30), "deepseek-v4-flash");
  assert.equal(modelLabel("very-long-provider/model-with-a-very-long-name", 18), "model-…ong-name");
  assert.equal(modelLabel("", 8), "model");
});

test("formatContextUsage supports numeric and missing status values", () => {
  assert.equal(
    formatContextUsage({ context_window: { used_tokens: 3983, max_tokens: 100000 } }),
    "4% 3,983/100k",
  );
  assert.equal(formatContextUsage({}), "context --");
});

test("contentWidth bounds assistant column for compact normal and wide terminals", () => {
  assert.equal(contentWidth(72), 64);
  assert.equal(contentWidth(100), 88);
  assert.equal(contentWidth(180), 100);
});
```

- [ ] **Step 2: Run failing layout tests**

Run:

```bash
npm --prefix tui/node test -- test/layout.test.ts
```

Expected: FAIL because `tui/node/src/app/layout.ts` does not exist.

- [ ] **Step 3: Add pure layout helpers**

Create `tui/node/src/app/layout.ts`:

```ts
export const DEFAULT_TERMINAL_WIDTH = 100;
export const MIN_CONTENT_WIDTH = 56;
export const MAX_CONTENT_WIDTH = 100;

export function truncateMiddle(value: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }
  if (value.length <= maxWidth) {
    return value;
  }
  if (maxWidth <= 1) {
    return "…".slice(0, maxWidth);
  }
  const remaining = maxWidth - 1;
  const left = Math.ceil(remaining / 2);
  const right = Math.floor(remaining / 2);
  return `${value.slice(0, left)}…${value.slice(value.length - right)}`;
}

export function workspaceLabel(value: string, maxWidth = 28): string {
  const parts = value.split("/").filter(Boolean);
  const basename = parts.at(-1) ?? value;
  return truncateMiddle(basename || "workspace", maxWidth);
}

export function modelLabel(value: string, maxWidth = 28): string {
  const parts = value.split("/").filter(Boolean);
  const label = parts.at(-1) ?? value;
  return truncateMiddle(label || "model", maxWidth);
}

function compactTokenCount(value: number): string {
  if (value >= 1000) {
    const rounded = value % 1000 === 0 ? String(value / 1000) : (value / 1000).toFixed(1);
    return `${rounded.replace(/\.0$/, "")}k`;
  }
  return value.toLocaleString("en-US");
}

export function formatContextUsage(status: Record<string, unknown>): string {
  const context = status.context_window as
    | { used_tokens?: unknown; max_tokens?: unknown }
    | undefined;
  const used = typeof context?.used_tokens === "number" ? context.used_tokens : null;
  const max = typeof context?.max_tokens === "number" ? context.max_tokens : null;
  if (used === null || max === null || max <= 0) {
    return "context --";
  }
  const percent = Math.round((used / max) * 100);
  return `${percent}% ${used.toLocaleString("en-US")}/${compactTokenCount(max)}`;
}

export function contentWidth(terminalWidth = DEFAULT_TERMINAL_WIDTH): number {
  const available = Math.max(terminalWidth - 8, MIN_CONTENT_WIDTH);
  return Math.min(Math.max(available, MIN_CONTENT_WIDTH), MAX_CONTENT_WIDTH);
}
```

- [ ] **Step 4: Run layout tests and typecheck**

Run:

```bash
npm --prefix tui/node test -- test/layout.test.ts
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tui/node/src/app/layout.ts tui/node/test/layout.test.ts
git commit -m "Add Node TUI layout helpers" \
  -m "Visual Structure V2 needs deterministic truncation, labels, context usage, and content widths before component layout changes." \
  -m "Constraint: Layout helpers are pure Node UI helpers and must not read terminal state or Python runtime data directly." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: npm --prefix tui/node test -- test/layout.test.ts" \
  -m "Tested: npm --prefix tui/node run typecheck"
```

---

### Task 2: Header Band And Welcome Panel

**Files:**
- Modify: `tui/node/src/app/Header.tsx`
- Create: `tui/node/src/app/WelcomePanel.tsx`
- Modify: `tui/node/src/app/App.tsx`
- Create: `tui/node/test/header-welcome.test.tsx`
- Modify: `tui/node/test/status-input.test.tsx`

- [ ] **Step 1: Write failing header and welcome tests**

Create `tui/node/test/header-welcome.test.tsx`:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { Header } from "../src/app/Header.tsx";
import { WelcomePanel, hasConversationContent } from "../src/app/WelcomePanel.tsx";
import { initialState, reduceShellState } from "../src/state/reducer.ts";

test("header band keeps core metadata inside compact width", () => {
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
  assert.match(frame, /deepseek-v4-flash|deepseek/);
  assert.match(frame, /4% 3,983\/100k/);
  assert.doesNotMatch(frame, /\\.worktrees\/fix-deepseek-cache-hit-rate/);
});

test("welcome panel renders startup mark only before conversation content", () => {
  let state = reduceShellState(initialState({ rawThemeName: "deep-teal" }), {
    type: "bootstrap.result",
    payload: {
      session_id: "demo",
      workspace: "/repo/project",
      model: "deepseek-v4",
      provider: "deepseek/chat_completions",
      status: {},
      welcome: { startup_mark: { name: "default", text: "mycli-mark" }, tips: ["/help"] },
    },
  });

  assert.equal(hasConversationContent(state.transcript), false);
  assert.match(render(<WelcomePanel state={state} width={80} />).lastFrame() ?? "", /mycli-mark/);

  state = reduceShellState(state, { type: "user.submit", message: "你是谁" });

  assert.equal(hasConversationContent(state.transcript), true);
  assert.equal(render(<WelcomePanel state={state} width={80} />).lastFrame(), "");
});
```

- [ ] **Step 2: Run failing header and welcome tests**

Run:

```bash
npm --prefix tui/node test -- test/header-welcome.test.tsx
```

Expected: FAIL because `WelcomePanel.tsx` does not exist and `Header` does not accept `width`.

- [ ] **Step 3: Upgrade Header to a width-aware header band**

Replace `tui/node/src/app/Header.tsx` with:

```tsx
import React from "react";
import { Box, Text } from "ink";
import {
  DEFAULT_TERMINAL_WIDTH,
  formatContextUsage,
  modelLabel,
  truncateMiddle,
  workspaceLabel,
} from "./layout.ts";
import type { ShellState } from "../state/types.ts";

function fitRightSegment(state: ShellState, width: number): string {
  const model = modelLabel(state.model, width < 90 ? 18 : 28);
  const context = formatContextUsage(state.status);
  const full = `${model} · ${context} · ${state.themeName}`;
  if (full.length <= Math.max(18, Math.floor(width * 0.42))) {
    return full;
  }
  const withoutTheme = `${model} · ${context}`;
  if (withoutTheme.length <= Math.max(18, Math.floor(width * 0.42))) {
    return withoutTheme;
  }
  return truncateMiddle(withoutTheme, Math.max(18, Math.floor(width * 0.42)));
}

export function Header({
  state,
  width = DEFAULT_TERMINAL_WIDTH,
}: {
  state: ShellState;
  width?: number;
}) {
  const workspace = workspaceLabel(state.workspace, width < 90 ? 22 : 34);
  const session = state.sessionId ? truncateMiddle(state.sessionId, width < 90 ? 14 : 22) : "pending";
  const center = width < 90 ? session : `session ${session} · ${state.viewMode}`;
  const right = fitRightSegment(state, width);
  const dividerWidth = Math.max(24, Math.min(width, DEFAULT_TERMINAL_WIDTH));

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box justifyContent="space-between" width={dividerWidth}>
        <Text>
          <Text color={state.theme.accent} bold>
            mycli
          </Text>
          <Text color={state.theme.muted}>  {workspace}</Text>
        </Text>
        <Text color={state.theme.subtle}>{center}</Text>
        <Text color={state.theme.muted}>{right}</Text>
      </Box>
      <Text color={state.theme.border}>{"─".repeat(dividerWidth)}</Text>
    </Box>
  );
}
```

- [ ] **Step 4: Add display-only WelcomePanel**

Create `tui/node/src/app/WelcomePanel.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { DEFAULT_TERMINAL_WIDTH, truncateMiddle } from "./layout.ts";
import type { ShellState, TranscriptItem } from "../state/types.ts";

export function hasConversationContent(items: TranscriptItem[]): boolean {
  return items.some(
    (item) =>
      item.type === "user" ||
      item.type === "assistant_stream" ||
      item.type === "assistant_final" ||
      item.type === "tool_summary" ||
      item.type === "tool_detail",
  );
}

function welcomeItem(state: ShellState): TranscriptItem | undefined {
  return state.transcript.find(
    (item) => item.type === "system_notice" && typeof item.metadata.startup_mark === "object",
  );
}

export function WelcomePanel({
  state,
  width = DEFAULT_TERMINAL_WIDTH,
}: {
  state: ShellState;
  width?: number;
}) {
  if (hasConversationContent(state.transcript)) {
    return null;
  }
  const item = welcomeItem(state);
  if (!item) {
    return null;
  }
  const workspace = truncateMiddle(state.workspace || "workspace pending", Math.max(24, width - 12));
  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
      <Text color={state.theme.accent}>{item.text}</Text>
      <Text color={state.theme.subtle}>ready · {workspace} · /help for commands</Text>
    </Box>
  );
}
```

- [ ] **Step 5: Wire Header width and WelcomePanel in App**

Replace `tui/node/src/app/App.tsx` with:

```tsx
import React from "react";
import { Box } from "ink";
import { ApprovalPrompt } from "./ApprovalPrompt.tsx";
import { CompletionPopup } from "./CompletionPopup.tsx";
import { Header } from "./Header.tsx";
import { InputBox } from "./InputBox.tsx";
import { Overlay } from "./Overlay.tsx";
import { StatusLine } from "./StatusLine.tsx";
import { Transcript } from "./Transcript.tsx";
import { WelcomePanel } from "./WelcomePanel.tsx";
import { handleLocalCommand, isLocalCommand } from "../state/localCommands.ts";
import type { ShellAction } from "../state/reducer.ts";
import type { ShellState } from "../state/types.ts";

export function App({
  state,
  width = 100,
  onSubmit,
  onCommand,
  onLocalAction,
  onInterrupt,
  onDraftChange,
  onDecision,
}: {
  state: ShellState;
  width?: number;
  onSubmit?: (value: string) => void;
  onCommand?: (command: string) => void;
  onLocalAction?: (action: ShellAction) => void;
  onInterrupt?: () => void;
  onDraftChange?: (value: string) => void;
  onDecision?: (decisionId: string, choice: string) => void;
}) {
  return (
    <Box flexDirection="column" minHeight={10}>
      <Header state={state} width={width} />
      <WelcomePanel state={state} width={width} />
      <Transcript state={state} />
      <Overlay overlay={state.overlay} theme={state.theme} />
      <ApprovalPrompt
        pendingApproval={state.pendingApproval}
        onDecision={onDecision ?? (() => undefined)}
      />
      <CompletionPopup
        visible={state.completion.visible}
        items={state.completion.items}
        selectedIndex={state.completion.selectedIndex}
      />
      <InputBox
        draft={state.inputDraft}
        turnRunning={state.turnRunning}
        completionVisible={state.completion.visible}
        theme={state.theme}
        onDraftChange={onDraftChange ?? (() => undefined)}
        onSubmit={(value) => {
          if (value.startsWith("/") && isLocalCommand(value)) {
            onLocalAction?.(handleLocalCommand(value, state));
            return;
          }
          if (value.startsWith("/")) {
            onCommand?.(value);
            return;
          }
          onSubmit?.(value);
        }}
        onInterrupt={onInterrupt ?? (() => undefined)}
      />
      <StatusLine state={state} />
    </Box>
  );
}
```

- [ ] **Step 6: Hide bootstrap welcome notices from raw transcript rendering**

Modify `tui/node/src/app/Transcript.tsx` in `TranscriptRow` before other system notice handling:

```tsx
  if (item.type === "system_notice" && typeof item.metadata.startup_mark === "object") {
    return null;
  }
```

- [ ] **Step 7: Update existing status/header tests**

Modify `tui/node/test/status-input.test.tsx` so `Header` calls pass a deterministic width:

```tsx
const { lastFrame } = render(<Header state={state} width={100} />);
```

- [ ] **Step 8: Run header/welcome tests and typecheck**

Run:

```bash
npm --prefix tui/node test -- test/header-welcome.test.tsx test/status-input.test.tsx test/app.test.tsx
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add tui/node/src/app/Header.tsx tui/node/src/app/WelcomePanel.tsx tui/node/src/app/App.tsx tui/node/src/app/Transcript.tsx tui/node/test/header-welcome.test.tsx tui/node/test/status-input.test.tsx
git commit -m "Add Node TUI header band and compact welcome" \
  -m "The main screen now separates app chrome from transcript content by using a width-aware header band and a display-only welcome surface that disappears after conversation content starts." \
  -m "Constraint: Welcome visibility is Node presentation state only and does not mutate Python transcript semantics." \
  -m "Rejected: Keep the startup mark as a permanent transcript row | it dominates active conversations and was the primary screenshot-level failure." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: npm --prefix tui/node test -- test/header-welcome.test.tsx test/status-input.test.tsx test/app.test.tsx" \
  -m "Tested: npm --prefix tui/node run typecheck"
```

---

### Task 3: User And Assistant Transcript Structure

**Files:**
- Create: `tui/node/src/app/UserPromptRow.tsx`
- Create: `tui/node/src/app/AssistantBlock.tsx`
- Modify: `tui/node/src/app/MarkdownText.tsx`
- Modify: `tui/node/src/app/Transcript.tsx`
- Create: `tui/node/test/transcript-structure.test.tsx`
- Modify: `tui/node/test/transcript.test.ts`

- [ ] **Step 1: Write failing transcript structure tests**

Create `tui/node/test/transcript-structure.test.tsx`:

```tsx
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
```

- [ ] **Step 2: Run failing transcript structure tests**

Run:

```bash
npm --prefix tui/node test -- test/transcript-structure.test.tsx
```

Expected: FAIL because `UserPromptRow.tsx` and `AssistantBlock.tsx` do not exist and `Transcript` does not accept `width`.

- [ ] **Step 3: Add UserPromptRow**

Create `tui/node/src/app/UserPromptRow.tsx`:

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
      <Text color={theme.accent}>› </Text>
      <Box width={contentWidth(width)}>
        <Text color={theme.text}>{text}</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 4: Add AssistantBlock**

Create `tui/node/src/app/AssistantBlock.tsx`:

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
    <Box marginLeft={1}>
      <Text color={theme.border}>│ </Text>
      <Box width={columnWidth} flexDirection="column">
        {final ? (
          <MarkdownText text={text} theme={theme} width={columnWidth} />
        ) : (
          <Text color={theme.text}>{text}</Text>
        )}
      </Box>
    </Box>
  );
}
```

- [ ] **Step 5: Make MarkdownText width-aware without changing markdown behavior**

Modify `tui/node/src/app/MarkdownText.tsx` function signature:

```tsx
export function MarkdownText({
  text,
  theme,
  width,
}: {
  text: string;
  theme: ThemeTokens;
  width?: number;
}) {
```

Modify the root `<Box>`:

```tsx
<Box flexDirection="column" width={width}>
```

Do not change the existing inline code, bold, list, or fenced code parsing logic.

- [ ] **Step 6: Route user and assistant rows in Transcript**

Modify `tui/node/src/app/Transcript.tsx` imports:

```tsx
import { AssistantBlock } from "./AssistantBlock.tsx";
import { UserPromptRow } from "./UserPromptRow.tsx";
import { DEFAULT_TERMINAL_WIDTH } from "./layout.ts";
```

Modify `TranscriptRow` props:

```tsx
  width,
}: {
  item: TranscriptItem;
  viewMode: ShellState["viewMode"];
  theme: ThemeTokens;
  width: number;
}) {
```

Add row routing before the default fallback:

```tsx
  if (item.type === "user") {
    return <UserPromptRow text={item.text} theme={theme} width={width} />;
  }
  if (item.type === "assistant_stream") {
    return <AssistantBlock text={item.text} final={false} theme={theme} width={width} />;
  }
  if (item.type === "assistant_final") {
    return <AssistantBlock text={item.text} final={true} theme={theme} width={width} />;
  }
```

Remove the old direct `assistant_final` routing to `MarkdownText`.

Modify `Transcript` signature and map:

```tsx
export function Transcript({
  state,
  width = DEFAULT_TERMINAL_WIDTH,
}: {
  state: ShellState;
  width?: number;
}) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {state.transcript.map((item) => (
        <TranscriptRow
          key={item.id}
          item={item}
          viewMode={state.viewMode}
          theme={state.theme}
          width={width}
        />
      ))}
      {state.turnRunning ? <Text dimColor>Thinking...</Text> : null}
    </Box>
  );
}
```

- [ ] **Step 7: Pass width from App to Transcript**

Modify `tui/node/src/app/App.tsx`:

```tsx
<Transcript state={state} width={width} />
```

- [ ] **Step 8: Run transcript tests and typecheck**

Run:

```bash
npm --prefix tui/node test -- test/transcript-structure.test.tsx test/transcript.test.ts test/markdown-text.test.tsx test/app.test.tsx
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add tui/node/src/app/UserPromptRow.tsx tui/node/src/app/AssistantBlock.tsx tui/node/src/app/MarkdownText.tsx tui/node/src/app/Transcript.tsx tui/node/src/app/App.tsx tui/node/test/transcript-structure.test.tsx tui/node/test/transcript.test.ts
git commit -m "Structure Node TUI user and assistant rows" \
  -m "User prompts and assistant answers now use focused row components with an accent prompt marker, restrained assistant rail, and bounded content width instead of plain transcript rows." \
  -m "Constraint: Streaming remains plain text and final answers keep the existing narrow markdown renderer." \
  -m "Rejected: Large assistant cards with role labels | the target is Claude-Code-like structure without role-card noise." \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: npm --prefix tui/node test -- test/transcript-structure.test.tsx test/transcript.test.ts test/markdown-text.test.tsx test/app.test.tsx" \
  -m "Tested: npm --prefix tui/node run typecheck"
```

---

### Task 4: Tool Timeline And Running Activity

**Files:**
- Modify: `tui/node/src/app/ToolRow.tsx`
- Create: `tui/node/src/app/RunningActivity.tsx`
- Modify: `tui/node/src/app/Transcript.tsx`
- Modify: `tui/node/src/app/App.tsx`
- Create: `tui/node/test/tool-activity.test.tsx`
- Modify: `tui/node/test/tool-summary.test.ts`

- [ ] **Step 1: Write failing tool activity tests**

Create `tui/node/test/tool-activity.test.tsx`:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { RunningActivity, activityPath } from "../src/app/RunningActivity.tsx";
import { ToolRow } from "../src/app/ToolRow.tsx";
import { initialState } from "../src/state/reducer.ts";

test("tool row renders timeline columns with status detail", () => {
  const state = initialState({ rawThemeName: "deep-teal" });
  const { lastFrame } = render(
    <ToolRow
      summary={{ verb: "read", target: "pyproject.toml", status: "done", detail: "82ms" }}
      theme={state.theme}
      width={80}
    />,
  );
  const frame = lastFrame() ?? "";

  assert.match(frame, /read/);
  assert.match(frame, /pyproject\.toml/);
  assert.match(frame, /done 82ms/);
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

test("running activity line renders elapsed time and path", () => {
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

  assert.match(frame, /thinking 12s/);
  assert.match(frame, /read/);
});
```

- [ ] **Step 2: Run failing tool activity tests**

Run:

```bash
npm --prefix tui/node test -- test/tool-activity.test.tsx
```

Expected: FAIL because `RunningActivity.tsx` does not exist and `ToolRow` does not accept `width`.

- [ ] **Step 3: Upgrade ToolRow timeline layout**

Replace `tui/node/src/app/ToolRow.tsx` with:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { DEFAULT_TERMINAL_WIDTH, truncateMiddle } from "./layout.ts";
import type { ToolSummary } from "../state/toolSummary.ts";
import type { ThemeTokens } from "../theme/types.ts";

export function ToolRow({
  summary,
  theme,
  width = DEFAULT_TERMINAL_WIDTH,
}: {
  summary: ToolSummary;
  theme: ThemeTokens;
  width?: number;
}) {
  const statusColor =
    summary.status === "failed"
      ? theme.error
      : summary.status === "running"
        ? theme.warning
        : summary.status === "done"
          ? theme.success
          : theme.muted;
  const targetWidth = width < 90 ? 28 : 44;
  const target = truncateMiddle(summary.target, targetWidth);
  const status = summary.detail ? `${summary.status} ${summary.detail}` : summary.status;

  return (
    <Box marginLeft={2}>
      <Box width={8}>
        <Text color={statusColor}>{truncateMiddle(summary.verb, 7)}</Text>
      </Box>
      <Box width={targetWidth + 2}>
        <Text color={theme.muted}>{target}</Text>
      </Box>
      <Text color={statusColor}>{status}</Text>
    </Box>
  );
}
```

- [ ] **Step 4: Add RunningActivity**

Create `tui/node/src/app/RunningActivity.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { formatToolSummary } from "../state/toolSummary.ts";
import type { ShellState, TranscriptItem } from "../state/types.ts";

export function activityPath(items: TranscriptItem[]): string {
  const verbs = items
    .filter((item) => item.type === "tool_summary")
    .slice(-3)
    .map((item) =>
      formatToolSummary({
        tool_name: item.metadata.tool_name ?? item.metadata.toolName ?? item.text.split(/\s+/, 1)[0],
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
    <Box marginLeft={2}>
      <Text color={state.theme.warning}>
        thinking {elapsedSeconds}s{path ? ` · ${path}` : ""}
      </Text>
    </Box>
  );
}
```

- [ ] **Step 5: Pass width to ToolRow from Transcript**

Modify `tui/node/src/app/Transcript.tsx` tool row routing:

```tsx
      <ToolRow
        summary={formatToolSummary({
          tool_name:
            item.metadata.tool_name ?? item.metadata.toolName ?? item.text.split(/\s+/, 1)[0],
          text: item.text,
          metadata: item.metadata,
        })}
        theme={theme}
        width={width}
      />
```

Remove the old `Thinking...` line from `Transcript`; running activity now lives in `App`.

- [ ] **Step 6: Wire RunningActivity in App**

Modify `tui/node/src/app/App.tsx` imports:

```tsx
import { RunningActivity } from "./RunningActivity.tsx";
```

Render it after `Transcript` and before overlays:

```tsx
<Transcript state={state} width={width} />
<RunningActivity state={state} />
```

- [ ] **Step 7: Run tool activity tests and typecheck**

Run:

```bash
npm --prefix tui/node test -- test/tool-activity.test.tsx test/tool-summary.test.ts test/transcript.test.ts test/app.test.tsx
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tui/node/src/app/ToolRow.tsx tui/node/src/app/RunningActivity.tsx tui/node/src/app/Transcript.tsx tui/node/src/app/App.tsx tui/node/test/tool-activity.test.tsx
git commit -m "Render Node TUI tool timeline and running activity" \
  -m "Tool rows now read as aligned execution telemetry, and running turns show a compact thinking line with a local path derived from recent tool summaries." \
  -m "Constraint: Running activity is derived display state only and must not become Python session state of record." \
  -m "Rejected: Animated spinner for this slice | stable text is easier to test and avoids layout jitter." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: npm --prefix tui/node test -- test/tool-activity.test.tsx test/tool-summary.test.ts test/transcript.test.ts test/app.test.tsx" \
  -m "Tested: npm --prefix tui/node run typecheck"
```

---

### Task 5: Bottom Command Bar

**Files:**
- Modify: `tui/node/src/app/InputBox.tsx`
- Modify: `tui/node/src/app/StatusLine.tsx`
- Modify: `tui/node/src/app/App.tsx`
- Create: `tui/node/test/command-bar.test.tsx`
- Modify: `tui/node/test/input.test.tsx`
- Modify: `tui/node/test/status-input.test.tsx`

- [ ] **Step 1: Write failing command bar tests**

Create `tui/node/test/command-bar.test.tsx`:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { InputBox } from "../src/app/InputBox.tsx";
import { initialState } from "../src/state/reducer.ts";

test("command bar renders divider prompt placeholder and compact metadata", () => {
  const state = {
    ...initialState({ rawThemeName: "graphite" }),
    workspace: "/repo/project",
    model: "deepseek-v4-flash",
    status: { context_window: { used_tokens: 3983, max_tokens: 100000 } },
  };

  const { lastFrame } = render(
    <InputBox
      draft=""
      turnRunning={false}
      completionVisible={false}
      theme={state.theme}
      metadata="default · graphite · 3,983/100k"
      width={80}
      onDraftChange={() => undefined}
      onSubmit={() => undefined}
      onInterrupt={() => undefined}
    />,
  );
  const frame = lastFrame() ?? "";

  assert.match(frame, /─/);
  assert.match(frame, /› Type a message or \/command/);
  assert.match(frame, /default · graphite/);
});

test("command bar shows command hint for slash drafts", () => {
  const state = initialState({ rawThemeName: "mono" });
  const { lastFrame } = render(
    <InputBox
      draft="/theme"
      turnRunning={false}
      completionVisible={false}
      theme={state.theme}
      metadata="default · mono"
      width={80}
      onDraftChange={() => undefined}
      onSubmit={() => undefined}
      onInterrupt={() => undefined}
    />,
  );

  assert.match(lastFrame() ?? "", /local UI command or Python slash command/);
});
```

- [ ] **Step 2: Run failing command bar tests**

Run:

```bash
npm --prefix tui/node test -- test/command-bar.test.tsx
```

Expected: FAIL because `InputBox` does not accept `metadata` or `width`.

- [ ] **Step 3: Add command bar props and layout to InputBox**

Modify `tui/node/src/app/InputBox.tsx` imports:

```tsx
import { DEFAULT_TERMINAL_WIDTH, truncateMiddle } from "./layout.ts";
```

Add props:

```tsx
  metadata = "",
  width = DEFAULT_TERMINAL_WIDTH,
```

Add types:

```tsx
  metadata?: string;
  width?: number;
```

Replace the current return block with:

```tsx
  const isCommand = value.startsWith("/");
  const dividerWidth = Math.max(24, Math.min(width, DEFAULT_TERMINAL_WIDTH));
  const metadataWidth = Math.max(16, Math.floor(dividerWidth * 0.34));
  const visibleMetadata = truncateMiddle(metadata, metadataWidth);
  return (
    <Box flexDirection="column">
      <Text color={theme.border}>{"─".repeat(dividerWidth)}</Text>
      <Box justifyContent="space-between" width={dividerWidth}>
        <Text>
          <Text color={turnRunning ? theme.warning : theme.accent}>› </Text>
          <Text color={value ? theme.text : theme.subtle}>{value || "Type a message or /command"}</Text>
        </Text>
        <Text color={theme.subtle}>{visibleMetadata}</Text>
      </Box>
      {isCommand ? <Text color={theme.subtle}>local UI command or Python slash command</Text> : null}
    </Box>
  );
```

- [ ] **Step 4: Make StatusLine a compact metadata renderer**

Replace `tui/node/src/app/StatusLine.tsx` with:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { formatContextUsage, workspaceLabel } from "./layout.ts";
import type { ShellState } from "../state/types.ts";

export function statusMetadata(state: ShellState): string {
  const parts = [
    workspaceLabel(state.workspace, 20),
    state.viewMode,
    state.themeName,
    formatContextUsage(state.status),
  ];
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

- [ ] **Step 5: Wire metadata and remove standalone bottom StatusLine in App**

Modify `tui/node/src/app/App.tsx` imports:

```tsx
import { statusMetadata } from "./StatusLine.tsx";
```

Remove the standalone `<StatusLine state={state} />` render at the bottom.

Modify the `InputBox` call in `tui/node/src/app/App.tsx` to include metadata and width while preserving existing submit routing:

```tsx
      <InputBox
        draft={state.inputDraft}
        turnRunning={state.turnRunning}
        completionVisible={state.completion.visible}
        theme={state.theme}
        metadata={statusMetadata(state)}
        width={width}
        onDraftChange={onDraftChange ?? (() => undefined)}
        onSubmit={(value) => {
          if (value.startsWith("/") && isLocalCommand(value)) {
            onLocalAction?.(handleLocalCommand(value, state));
            return;
          }
          if (value.startsWith("/")) {
            onCommand?.(value);
            return;
          }
          onSubmit?.(value);
        }}
        onInterrupt={onInterrupt ?? (() => undefined)}
      />
```

- [ ] **Step 6: Update existing input/status tests**

Modify `tui/node/test/input.test.tsx` and `tui/node/test/status-input.test.tsx` `InputBox` calls to pass:

```tsx
metadata="default · deep-teal"
width={80}
```

Modify `tui/node/test/status-input.test.tsx` status line assertion to accept the compact metadata string:

```tsx
assert.match(frame, /project/);
assert.match(frame, /verbose/);
assert.match(frame, /mono/);
assert.match(frame, /4% 3,983\/100k/);
```

Remove assertions expecting the model name in `StatusLine`; the model is now in `Header`.

- [ ] **Step 7: Run command bar tests and typecheck**

Run:

```bash
npm --prefix tui/node test -- test/command-bar.test.tsx test/input.test.tsx test/status-input.test.tsx test/app.test.tsx
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tui/node/src/app/InputBox.tsx tui/node/src/app/StatusLine.tsx tui/node/src/app/App.tsx tui/node/test/command-bar.test.tsx tui/node/test/input.test.tsx tui/node/test/status-input.test.tsx
git commit -m "Stabilize Node TUI bottom command bar" \
  -m "Input and status metadata now share a single command bar with width-aware metadata elision, preventing the broken bottom wrapping seen in the main TTY screenshot." \
  -m "Constraint: Command bar metadata is display-only Node UI state derived from ShellState." \
  -m "Rejected: Keep separate input and status rows | they wrap independently and make the shell look like a plain log." \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: npm --prefix tui/node test -- test/command-bar.test.tsx test/input.test.tsx test/status-input.test.tsx test/app.test.tsx" \
  -m "Tested: npm --prefix tui/node run typecheck"
```

---

### Task 6: Integrated Visual Structure Snapshot

**Files:**
- Create: `tui/node/test/app-visual-structure.test.tsx`
- Modify: `tui/node/test/app-polish.test.tsx`

- [ ] **Step 1: Write integrated V2 anatomy test**

Create `tui/node/test/app-visual-structure.test.tsx`:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/app/App.tsx";
import { initialState, reduceShellState } from "../src/state/reducer.ts";

test("app renders visual structure v2 anatomy", () => {
  let state = initialState({ rawThemeName: "graphite" });
  state = reduceShellState(state, {
    type: "bootstrap.result",
    payload: {
      session_id: "default",
      workspace: "/Users/cosmos/Desktop/mycli/.worktrees/fix-deepseek-cache-hit-rate",
      model: "deepseek/chat/deepseek-v4-flash",
      provider: "deepseek/chat_completions",
      status: { context_window: { used_tokens: 3983, max_tokens: 100000 } },
      welcome: { startup_mark: { name: "default", text: "mycli" }, tips: ["/help"] },
    },
  });
  state = reduceShellState(state, { type: "user.submit", message: "你是谁" });
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
        text: "我是 **mycli**，一个运行在本地机器上的编程助手。入口是 `mycli.cli.main:main`。",
        folded: false,
        metadata: {},
      },
    ],
  };

  const { lastFrame } = render(<App state={state} width={80} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /mycli/);
  assert.match(frame, /fix-de/);
  assert.match(frame, /deepseek/);
  assert.match(frame, /› 你是谁/);
  assert.match(frame, /read/);
  assert.match(frame, /pyproject\.toml/);
  assert.match(frame, /│/);
  assert.match(frame, /mycli\.cli\.main:main/);
  assert.match(frame, /Type a message or \/command/);
  assert.doesNotMatch(frame, /USER|ASSISTANT|TOOL/);
});
```

- [ ] **Step 2: Run failing or updating integrated test**

Run:

```bash
npm --prefix tui/node test -- test/app-visual-structure.test.tsx
```

Expected: PASS if previous tasks are complete. If it fails, update only the implementation, not the assertions, unless the assertion contradicts the spec.

- [ ] **Step 3: Update app-polish compatibility test**

Modify `tui/node/test/app-polish.test.tsx` render call to pass width:

```tsx
const { lastFrame } = render(<App state={state} width={80} />);
```

Keep assertions that verify brand, theme, tool row, markdown content, and no role labels.

- [ ] **Step 4: Run integrated Node tests and typecheck**

Run:

```bash
npm --prefix tui/node test -- test/app-visual-structure.test.tsx test/app-polish.test.tsx test/app.test.tsx
npm --prefix tui/node test
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tui/node/test/app-visual-structure.test.tsx tui/node/test/app-polish.test.tsx
git commit -m "Cover Node TUI visual structure anatomy" \
  -m "The integrated snapshot now checks the V2 screen anatomy directly: header band, prompt row, tool timeline, assistant rail, command bar, and no large role labels." \
  -m "Constraint: This task adds verification only; Python runtime behavior remains unchanged." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: npm --prefix tui/node test -- test/app-visual-structure.test.tsx test/app-polish.test.tsx test/app.test.tsx" \
  -m "Tested: npm --prefix tui/node test" \
  -m "Tested: npm --prefix tui/node run typecheck"
```

---

### Task 7: Full Verification And Smoke Report

**Files:**
- Create: `docs/superpowers/reports/2026-05-27-node-tui-visual-structure-v2-smoke.md`

- [ ] **Step 1: Run focused Python regression tests**

Run:

```bash
uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py -q
```

Expected: PASS.

- [ ] **Step 2: Run full static checks and Python suite**

Run:

```bash
uv run ruff check src tests
uv run mypy src/mycli
uv run pytest -q
```

Expected: PASS.

- [ ] **Step 3: Run scripted Node TUI smoke**

Run:

```bash
SMOKE_HOME="$(mktemp -d)"
SESSION="node-tui-visual-structure-v2-scripted-smoke-$(date +%Y%m%d%H%M%S)"
SCRIPT='["你是谁","/theme graphite","/usage","/sessions","/clear","/quit"]'
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

- [ ] **Step 4: Run manual TTY smoke**

Run:

```bash
MYCLI_TUI_THEME=deep-teal uv run mycli --session node-tui-visual-structure-v2-manual-smoke
```

Manual checklist:

```text
1. Empty session shows compact branded startup surface.
2. Ask: 你是谁
3. After the answer starts, welcome no longer dominates the transcript.
4. User prompt uses › and no USER label.
5. Assistant answer uses a subtle left rail and no ASSISTANT label.
6. Assistant text is bounded and readable, not full-width across a wide terminal.
7. /theme graphite visibly changes rails, separators, and labels.
8. /usage and /sessions overlays still work.
9. /clear clears visible transcript only.
10. /quit exits cleanly.
```

- [ ] **Step 5: Write smoke report**

Create `docs/superpowers/reports/2026-05-27-node-tui-visual-structure-v2-smoke.md`:

```markdown
# Node TUI Visual Structure V2 Smoke

## Scope

- Header band.
- Compact display-only welcome surface.
- User prompt row.
- Assistant rail block with bounded final markdown.
- Tool timeline rows.
- Running activity line.
- Bottom command bar.
- Width-aware truncation and metadata elision.

## Verification

| Command | Result |
| --- | --- |
| `npm --prefix tui/node test` | PASS |
| `npm --prefix tui/node run typecheck` | PASS |
| `uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py -q` | PASS |
| `uv run ruff check src tests` | PASS |
| `uv run mypy src/mycli` | PASS |
| `uv run pytest -q` | PASS |
| `MYCLI_TUI_THEME=deep-teal MYCLI_NODE_TUI_SCRIPT='["你是谁","/theme graphite","/usage","/sessions","/clear","/quit"]' uv run mycli --node-tui --session <scripted-session>` | PASS |
| `MYCLI_TUI_THEME=deep-teal uv run mycli --session node-tui-visual-structure-v2-manual-smoke` | PASS |

## Manual Notes

- Header band rendered brand, workspace, session/model/context without broken wrapping.
- Welcome mark did not dominate after conversation content appeared.
- User and assistant rows were visually distinct without role cards.
- Assistant text used a bounded column and left rail.
- `/theme graphite` changed visible rails, separators, and labels.
- `/usage` and `/sessions` overlays remained functional.
- `/clear` cleared visible transcript only.
- `/quit` exited cleanly.
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/reports/2026-05-27-node-tui-visual-structure-v2-smoke.md
git commit -m "Verify Node TUI visual structure V2" \
  -m "Visual Structure V2 is verified across Node tests, TypeScript, focused Python regressions, static checks, full pytest, scripted smoke, and manual TTY smoke." \
  -m "Constraint: Verification confirms the UI-only slice preserves Python runtime authority." \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: npm --prefix tui/node test" \
  -m "Tested: npm --prefix tui/node run typecheck" \
  -m "Tested: uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py -q" \
  -m "Tested: uv run ruff check src tests" \
  -m "Tested: uv run mypy src/mycli" \
  -m "Tested: uv run pytest -q" \
  -m "Tested: scripted and manual Node TUI visual structure smokes"
```

---

## Self-Review Checklist

- Spec coverage:
  - Header band: Task 2.
  - Compact welcome: Task 2.
  - Distinct transcript row types: Task 3 and Task 4.
  - User prompt marker: Task 3.
  - Assistant rail and bounded content: Task 3.
  - Tool timeline rows: Task 4.
  - Running activity line: Task 4.
  - Bottom command bar: Task 5.
  - Width handling: Task 1, Task 2, Task 3, Task 5, Task 6.
  - Visual smoke: Task 7.
- Non-goals preserved:
  - No Python gateway redesign.
  - No JSON-RPC protocol expansion.
  - No new dependencies.
  - No custom theme editor.
  - No mouse-first UI.
  - No prompt/session/tool/runtime changes.
- Implementation decisions:
  - `StatusLine` metadata is folded into `InputBox` command bar while keeping a compatibility export.
  - Width props are optional and deterministic for tests.
  - Welcome is hidden after real conversation content appears.
  - Assistant streaming and final answers both use the left rail.
  - Header/command bar truncation priorities are implemented in Node layout helpers and component-local fitting logic.
