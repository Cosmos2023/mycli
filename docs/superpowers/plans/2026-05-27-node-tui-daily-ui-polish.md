# Node TUI Daily UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing Node Ink TUI from a sparse protocol shell into a daily-usable branded console with typed themes, clearer transcript hierarchy, structured tool rows, polished overlays/status/input, and basic markdown rendering.

**Architecture:** Keep Python as the only runtime/session/tool/model authority. Implement the polish layer in Node as reducer state, pure formatters, and focused Ink components; `/theme` and `/clear` are local Node UI commands intercepted before JSON-RPC. Python gateway changes are avoided unless a later test proves command metadata must change.

**Tech Stack:** Python 3.13, pytest, ruff, mypy, Node.js >= 20, npm, TypeScript strict mode, React 19, Ink 6, Node `node:test`.

**Spec:** `docs/superpowers/specs/2026-05-27-node-tui-daily-ui-polish.md`

---

## File Structure

- `tui/node/src/theme/types.ts`: theme names, semantic token shape, theme resolution type.
- `tui/node/src/theme/themes.ts`: built-in `deep-teal`, `graphite`, `mono`, and `amber` themes.
- `tui/node/src/theme/resolveTheme.ts`: env/string theme resolution with fallback messaging.
- `tui/node/test/theme.test.ts`: resolver and token coverage.
- `tui/node/src/state/types.ts`: extend `ShellState` with theme fields and local command notices.
- `tui/node/src/state/reducer.ts`: theme actions, local command output rows, transcript clear.
- `tui/node/src/state/localCommands.ts`: parse and execute Node-only slash commands.
- `tui/node/test/local-commands.test.ts`: `/theme`, `/theme <name>`, invalid theme, `/clear`, and Python-command pass-through.
- `tui/node/src/app/Header.tsx`: branded header/welcome surface.
- `tui/node/src/app/StatusLine.tsx`: themed status line with workspace/session/view/theme/model/context.
- `tui/node/src/app/InputBox.tsx`: themed prompt, placeholder, command hint, running/idle state.
- `tui/node/test/status-input.test.tsx`: status/input snapshot coverage.
- `tui/node/src/state/toolSummary.ts`: pure tool summary formatter.
- `tui/node/src/app/ToolRow.tsx`: themed structured tool telemetry row.
- `tui/node/src/app/Transcript.tsx`: route tool/system/markdown rows through focused components.
- `tui/node/test/tool-summary.test.ts`: Read/Edit/Bash/Grep/unknown formatter coverage.
- `tui/node/src/app/Overlay.tsx`: themed overlay shell with title/content/footer/truncation marker.
- `tui/node/src/app/CommandOutput.tsx`: low-emphasis command output rows.
- `tui/node/src/app/SystemNotice.tsx`: themed system/warning/error notices.
- `tui/node/test/overlay-polish.test.tsx`: overlay truncation and themed shell snapshots.
- `tui/node/src/app/MarkdownText.tsx`: narrow markdown renderer for final assistant text.
- `tui/node/test/markdown-text.test.tsx`: inline code, bold, lists, fenced code, plain fallback.
- `tui/node/src/app/App.tsx`: pass theme through components and intercept local commands before gateway commands.
- `tui/node/src/index.tsx`: initialize theme from `MYCLI_TUI_THEME`.
- `tui/node/test/app-polish.test.tsx`: integrated branded console snapshot.
- `docs/superpowers/reports/2026-05-27-node-tui-daily-ui-polish-smoke.md`: final verification report.

Implementation decisions locked by this plan:

- `/theme` and `/clear` are Node-local commands. They must not call `command.run` and must not enter Python session history.
- Other slash commands still go through Python `command.run`.
- Theme persistence is process-local plus `MYCLI_TUI_THEME`; no database/session persistence in this slice.
- Markdown streams as plain text while a turn runs; final assistant text is markdown-rendered after `turn.completed`.
- No new markdown dependency in this slice. Use a narrow local renderer to keep scope small.

---

### Task 1: Theme Tokens And Resolution

**Files:**
- Create: `tui/node/src/theme/types.ts`
- Create: `tui/node/src/theme/themes.ts`
- Create: `tui/node/src/theme/resolveTheme.ts`
- Create: `tui/node/test/theme.test.ts`

- [ ] **Step 1: Write failing theme tests**

Create `tui/node/test/theme.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { resolveTheme } from "../src/theme/resolveTheme.ts";
import { THEMES } from "../src/theme/themes.ts";

test("resolves the default deep-teal theme when no name is provided", () => {
  const resolved = resolveTheme(undefined);

  assert.equal(resolved.ok, true);
  assert.equal(resolved.name, "deep-teal");
  assert.equal(resolved.theme.accent, THEMES["deep-teal"].accent);
});

test("resolves every built-in theme with the required semantic tokens", () => {
  const required = [
    "background",
    "surface",
    "surfaceRaised",
    "border",
    "text",
    "muted",
    "subtle",
    "accent",
    "success",
    "warning",
    "error",
    "code",
  ] as const;

  for (const name of ["deep-teal", "graphite", "mono", "amber"] as const) {
    const theme = THEMES[name];
    for (const token of required) {
      assert.equal(typeof theme[token], "string", `${name}.${token}`);
      assert.notEqual(theme[token].trim(), "", `${name}.${token}`);
    }
  }
});

test("unknown theme falls back to deep-teal with a message", () => {
  const resolved = resolveTheme("unknown-theme");

  assert.equal(resolved.ok, false);
  assert.equal(resolved.fallbackName, "deep-teal");
  assert.match(resolved.message, /Unknown theme: unknown-theme/);
  assert.equal(resolved.theme.accent, THEMES["deep-teal"].accent);
});
```

- [ ] **Step 2: Run failing theme tests**

Run:

```bash
npm --prefix tui/node test -- test/theme.test.ts
```

Expected: FAIL because `src/theme/resolveTheme.ts` does not exist.

- [ ] **Step 3: Add theme types**

Create `tui/node/src/theme/types.ts`:

```ts
export type ThemeName = "deep-teal" | "graphite" | "mono" | "amber";

export type ThemeTokens = {
  background: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  text: string;
  muted: string;
  subtle: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  code: string;
};

export type ThemeResolution =
  | { ok: true; name: ThemeName; theme: ThemeTokens }
  | { ok: false; fallbackName: ThemeName; theme: ThemeTokens; message: string };
```

- [ ] **Step 4: Add built-in themes**

Create `tui/node/src/theme/themes.ts`:

```ts
import type { ThemeName, ThemeTokens } from "./types.ts";

export const DEFAULT_THEME_NAME: ThemeName = "deep-teal";

export const THEMES: Record<ThemeName, ThemeTokens> = {
  "deep-teal": {
    background: "#0b1112",
    surface: "#0f1819",
    surfaceRaised: "#142223",
    border: "#1f3a3a",
    text: "#e4f2ef",
    muted: "#90aaa5",
    subtle: "#607a76",
    accent: "#5ee0c2",
    success: "#70d49a",
    warning: "#d7ba7d",
    error: "#ff7b7b",
    code: "#b8fff0",
  },
  graphite: {
    background: "#0d1015",
    surface: "#121820",
    surfaceRaised: "#172131",
    border: "#28384d",
    text: "#e8edf4",
    muted: "#9ba9bc",
    subtle: "#68778b",
    accent: "#8db7ff",
    success: "#8bd3dd",
    warning: "#e2c77d",
    error: "#ff8a8a",
    code: "#c7dcff",
  },
  mono: {
    background: "#0b0c0e",
    surface: "#111317",
    surfaceRaised: "#171a1f",
    border: "#3a3d42",
    text: "#f2f2f2",
    muted: "#9fa3aa",
    subtle: "#6f737a",
    accent: "#ffffff",
    success: "#d7dce2",
    warning: "#e5e7eb",
    error: "#ff9b9b",
    code: "#ffffff",
  },
  amber: {
    background: "#111316",
    surface: "#1a1714",
    surfaceRaised: "#211b16",
    border: "#3a3329",
    text: "#f3efe7",
    muted: "#b8a98f",
    subtle: "#817461",
    accent: "#e3b86f",
    success: "#c08c5a",
    warning: "#e3b86f",
    error: "#ff9478",
    code: "#f0d5a0",
  },
};
```

- [ ] **Step 5: Add resolver**

Create `tui/node/src/theme/resolveTheme.ts`:

```ts
import { DEFAULT_THEME_NAME, THEMES } from "./themes.ts";
import type { ThemeName, ThemeResolution } from "./types.ts";

export function isThemeName(value: string): value is ThemeName {
  return Object.hasOwn(THEMES, value);
}

export function resolveTheme(rawName: string | undefined): ThemeResolution {
  const requested = rawName?.trim();
  if (!requested) {
    return { ok: true, name: DEFAULT_THEME_NAME, theme: THEMES[DEFAULT_THEME_NAME] };
  }
  if (isThemeName(requested)) {
    return { ok: true, name: requested, theme: THEMES[requested] };
  }
  return {
    ok: false,
    fallbackName: DEFAULT_THEME_NAME,
    theme: THEMES[DEFAULT_THEME_NAME],
    message: `Unknown theme: ${requested}. Using ${DEFAULT_THEME_NAME}.`,
  };
}
```

- [ ] **Step 6: Run theme tests and typecheck**

Run:

```bash
npm --prefix tui/node test -- test/theme.test.ts
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tui/node/src/theme tui/node/test/theme.test.ts
git commit -m "Add typed Node TUI themes" \
  -m "The daily UI polish needs semantic colors instead of component-local literals. This adds the built-in theme registry and resolver used by reducer and Ink components." \
  -m "Constraint: Themes are Node UI state only and must not enter Python session history." \
  -m "Rejected: User-defined theme files in this slice | the approved scope only includes built-in themes." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: npm --prefix tui/node test -- test/theme.test.ts" \
  -m "Tested: npm --prefix tui/node run typecheck"
```

---

### Task 2: Reducer Theme State And Local Commands

**Files:**
- Modify: `tui/node/src/state/types.ts`
- Modify: `tui/node/src/state/reducer.ts`
- Create: `tui/node/src/state/localCommands.ts`
- Modify: `tui/node/src/app/App.tsx`
- Modify: `tui/node/src/index.tsx`
- Create: `tui/node/test/local-commands.test.ts`

- [ ] **Step 1: Write failing local command tests**

Create `tui/node/test/local-commands.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { initialState, reduceShellState } from "../src/state/reducer.ts";
import { handleLocalCommand, isLocalCommand } from "../src/state/localCommands.ts";

test("recognizes only Node-local slash commands", () => {
  assert.equal(isLocalCommand("/theme"), true);
  assert.equal(isLocalCommand("/theme mono"), true);
  assert.equal(isLocalCommand("/clear"), true);
  assert.equal(isLocalCommand("/usage"), false);
  assert.equal(isLocalCommand("/sessions"), false);
});

test("theme command changes reducer theme without gateway command.run", () => {
  const state = initialState({ rawThemeName: "deep-teal" });
  const action = handleLocalCommand("/theme mono", state);

  assert.equal(action.type, "theme.changed");
  const next = reduceShellState(state, action);
  assert.equal(next.themeName, "mono");
  assert.equal(next.themeNotice, "Theme changed to mono.");
  assert.equal(next.transcript.at(-1)?.type, "command_output");
});

test("bare theme command lists available themes and current theme", () => {
  const state = initialState({ rawThemeName: "graphite" });
  const action = handleLocalCommand("/theme", state);
  const next = reduceShellState(state, action);

  assert.equal(action.type, "local.command_output");
  assert.match(next.transcript.at(-1)?.text ?? "", /current=graphite/);
  assert.match(next.transcript.at(-1)?.text ?? "", /deep-teal, graphite, mono, amber/);
});

test("invalid theme command keeps current theme and records failure", () => {
  const state = initialState({ rawThemeName: "amber" });
  const action = handleLocalCommand("/theme missing", state);
  const next = reduceShellState(state, action);

  assert.equal(action.type, "theme.failed");
  assert.equal(next.themeName, "amber");
  assert.match(next.transcript.at(-1)?.text ?? "", /Unknown theme: missing/);
});

test("clear command clears visible transcript only", () => {
  let state = initialState({ rawThemeName: "deep-teal" });
  state = reduceShellState(state, { type: "user.submit", message: "hello" });
  const action = handleLocalCommand("/clear", state);
  const next = reduceShellState(state, action);

  assert.equal(action.type, "transcript.cleared");
  assert.equal(next.transcript.length, 1);
  assert.equal(next.transcript[0]?.type, "system_notice");
  assert.match(next.transcript[0]?.text ?? "", /Visible transcript cleared/);
});
```

- [ ] **Step 2: Run failing local command tests**

Run:

```bash
npm --prefix tui/node test -- test/local-commands.test.ts
```

Expected: FAIL because `localCommands.ts` and theme reducer actions do not exist.

- [ ] **Step 3: Extend state types**

Modify `tui/node/src/state/types.ts`:

```ts
import type { ThemeName, ThemeTokens } from "../theme/types.ts";

// Add to ShellState:
themeName: ThemeName;
theme: ThemeTokens;
themeNotice: string | null;
```

Do not remove existing fields.

- [ ] **Step 4: Extend reducer action types and initial state**

Modify `tui/node/src/state/reducer.ts` imports:

```ts
import { THEMES } from "../theme/themes.ts";
import { resolveTheme } from "../theme/resolveTheme.ts";
import type { ThemeName, ThemeTokens } from "../theme/types.ts";
```

Change `initialState()` signature:

```ts
export function initialState({
  rawThemeName,
}: { rawThemeName?: string } = {}): ShellState {
  const resolved = resolveTheme(rawThemeName);
  const themeName = resolved.ok ? resolved.name : resolved.fallbackName;
  return {
    sessionId: null,
    workspace: "",
    model: "",
    provider: "",
    status: {},
    transcript:
      resolved.ok
        ? []
        : [
            {
              id: itemId("theme"),
              type: "system_notice",
              text: resolved.message,
              folded: false,
              metadata: {},
            },
          ],
    inputDraft: "",
    restoredDraft: "",
    turnRunning: false,
    currentTurnId: null,
    viewMode: "default",
    completion: { visible: false, requestId: 0, prefix: "", items: [], selectedIndex: 0 },
    overlay: { visible: false, title: "", lines: [] },
    pendingApproval: null,
    themeName,
    theme: resolved.theme,
    themeNotice: resolved.ok ? null : resolved.message,
  };
}
```

- [ ] **Step 5: Add local reducer actions**

Extend `ShellAction` in `tui/node/src/state/reducer.ts`:

```ts
  | { type: "theme.changed"; themeName: ThemeName; theme: ThemeTokens; message: string }
  | { type: "theme.failed"; message: string }
  | { type: "local.command_output"; command: string; lines: string[] }
  | { type: "transcript.cleared"; message: string };
```

Add reducer cases before `gateway.event`:

```ts
  if (action.type === "theme.changed") {
    return {
      ...state,
      themeName: action.themeName,
      theme: action.theme,
      themeNotice: action.message,
      transcript: [
        ...state.transcript,
        {
          id: itemId("command"),
          type: "command_output",
          text: action.message,
          folded: false,
          metadata: { command: "/theme", theme: action.themeName },
        },
      ],
    };
  }
  if (action.type === "theme.failed") {
    return {
      ...state,
      themeNotice: action.message,
      transcript: [
        ...state.transcript,
        {
          id: itemId("warning"),
          type: "warning",
          text: action.message,
          folded: false,
          metadata: { command: "/theme" },
        },
      ],
    };
  }
  if (action.type === "local.command_output") {
    return {
      ...state,
      transcript: [
        ...state.transcript,
        {
          id: itemId("command"),
          type: "command_output",
          text: action.lines.join("\n"),
          folded: false,
          metadata: { command: action.command },
        },
      ],
    };
  }
  if (action.type === "transcript.cleared") {
    return {
      ...state,
      transcript: [
        {
          id: itemId("system"),
          type: "system_notice",
          text: action.message,
          folded: false,
          metadata: { local: true },
        },
      ],
      overlay: { visible: false, title: "", lines: [] },
    };
  }
```

- [ ] **Step 6: Add local command parser**

Create `tui/node/src/state/localCommands.ts`:

```ts
import { THEMES } from "../theme/themes.ts";
import { resolveTheme } from "../theme/resolveTheme.ts";
import type { ShellAction } from "./reducer.ts";
import type { ShellState } from "./types.ts";

const LOCAL_COMMANDS = new Set(["/theme", "/clear"]);

export function commandName(raw: string): string {
  return raw.trim().split(/\s+/, 1)[0] ?? "";
}

export function isLocalCommand(raw: string): boolean {
  return LOCAL_COMMANDS.has(commandName(raw));
}

export function handleLocalCommand(raw: string, state: ShellState): ShellAction {
  const trimmed = raw.trim();
  const name = commandName(trimmed);
  if (name === "/clear") {
    return { type: "transcript.cleared", message: "Visible transcript cleared." };
  }
  if (name === "/theme") {
    const requested = trimmed.split(/\s+/, 2)[1];
    if (!requested) {
      return {
        type: "local.command_output",
        command: "/theme",
        lines: [
          `current=${state.themeName}`,
          `available=${Object.keys(THEMES).join(", ")}`,
          "usage=/theme <name>",
        ],
      };
    }
    const resolved = resolveTheme(requested);
    if (!resolved.ok) {
      return { type: "theme.failed", message: resolved.message };
    }
    return {
      type: "theme.changed",
      themeName: resolved.name,
      theme: resolved.theme,
      message: `Theme changed to ${resolved.name}.`,
    };
  }
  return {
    type: "local.command_output",
    command: trimmed,
    lines: [`Unknown local command: ${trimmed}`],
  };
}
```

- [ ] **Step 7: Wire App local command interception**

Modify `tui/node/src/app/App.tsx` props:

```tsx
import { handleLocalCommand, isLocalCommand } from "../state/localCommands.ts";
import type { ShellAction } from "../state/reducer.ts";

// Add prop:
onLocalAction?: (action: ShellAction) => void;
```

Update the `InputBox` `onSubmit` callback in `App`:

```tsx
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
```

Modify `tui/node/src/index.tsx`:

```tsx
const [state, dispatch] = useReducer(
  reduceShellState,
  { rawThemeName: process.env.MYCLI_TUI_THEME },
  initialState,
);

// Pass:
onLocalAction={dispatch}
```

- [ ] **Step 8: Run local command tests and typecheck**

Run:

```bash
npm --prefix tui/node test -- test/local-commands.test.ts test/reducer.test.ts test/app.test.tsx
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add tui/node/src/state tui/node/src/app/App.tsx tui/node/src/index.tsx tui/node/test/local-commands.test.ts
git commit -m "Handle Node-local TUI commands" \
  -m "The theme system needs slash commands that mutate only Node UI state. This intercepts /theme and /clear before command.run while preserving Python ownership for every other slash command." \
  -m "Constraint: Local UI commands must not write Python session history or model-visible context." \
  -m "Rejected: Route /theme through Python command.run | it would make a UI-only preference look like runtime behavior." \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: npm --prefix tui/node test -- test/local-commands.test.ts test/reducer.test.ts test/app.test.tsx" \
  -m "Tested: npm --prefix tui/node run typecheck"
```

---

### Task 3: Branded Header, Status, And Input

**Files:**
- Create: `tui/node/src/app/Header.tsx`
- Modify: `tui/node/src/app/App.tsx`
- Modify: `tui/node/src/app/StatusLine.tsx`
- Modify: `tui/node/src/app/InputBox.tsx`
- Create: `tui/node/test/status-input.test.tsx`
- Modify: `tui/node/test/app.test.tsx`

- [ ] **Step 1: Write failing branded shell tests**

Create `tui/node/test/status-input.test.tsx`:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { Header } from "../src/app/Header.tsx";
import { InputBox } from "../src/app/InputBox.tsx";
import { StatusLine } from "../src/app/StatusLine.tsx";
import { initialState, reduceShellState } from "../src/state/reducer.ts";

test("header renders mycli brand, workspace, session, and theme", () => {
  const state = reduceShellState(initialState({ rawThemeName: "deep-teal" }), {
    type: "bootstrap.result",
    payload: {
      session_id: "demo",
      workspace: "/repo/project",
      model: "deepseek-v4",
      provider: "deepseek/chat_completions",
      status: { context_window: { used_tokens: 3983, max_tokens: 100000 } },
      welcome: {
        startup_mark: { name: "default", text: "mycli-mark" },
        tips: ["/help", "/usage"],
      },
    },
  });

  const { lastFrame } = render(<Header state={state} />);

  const frame = lastFrame() ?? "";
  assert.match(frame, /mycli/);
  assert.match(frame, /demo/);
  assert.match(frame, /deep-teal/);
  assert.match(frame, /project/);
});

test("status line renders compact workspace, view, theme, model, and context", () => {
  const state = {
    ...initialState({ rawThemeName: "mono" }),
    workspace: "/repo/project",
    model: "deepseek-v4",
    viewMode: "verbose" as const,
    status: { context_window: { used_tokens: 3983, max_tokens: 100000 } },
  };

  const { lastFrame } = render(<StatusLine state={state} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /project/);
  assert.match(frame, /verbose/);
  assert.match(frame, /mono/);
  assert.match(frame, /deepseek-v4/);
  assert.match(frame, /3,983 \/ 100,000/);
});

test("input shows placeholder and command hint", () => {
  const idle = render(
    <InputBox
      draft=""
      turnRunning={false}
      completionVisible={false}
      theme={initialState().theme}
      onDraftChange={() => undefined}
      onSubmit={() => undefined}
      onInterrupt={() => undefined}
    />,
  );
  assert.match(idle.lastFrame() ?? "", /Type a message or \/command/);

  const command = render(
    <InputBox
      draft="/theme"
      turnRunning={false}
      completionVisible={false}
      theme={initialState().theme}
      onDraftChange={() => undefined}
      onSubmit={() => undefined}
      onInterrupt={() => undefined}
    />,
  );
  assert.match(command.lastFrame() ?? "", /local UI command/);
});
```

- [ ] **Step 2: Run failing branded shell tests**

Run:

```bash
npm --prefix tui/node test -- test/status-input.test.tsx
```

Expected: FAIL because `Header.tsx` does not exist and `InputBox` does not accept `theme`.

- [ ] **Step 3: Add formatting helpers inside StatusLine**

Modify `tui/node/src/app/StatusLine.tsx`:

```tsx
function workspaceLabel(value: string): string {
  const parts = value.split("/").filter(Boolean);
  return parts.at(-1) ?? value;
}
```

Update `StatusLine` to render:

```tsx
const context = state.status.context_window as
  | { used_tokens?: number; max_tokens?: number }
  | undefined;
return (
  <Box justifyContent="space-between">
    <Text color={state.theme.muted}>
      {workspaceLabel(state.workspace)} · {state.viewMode} · {state.themeName}
    </Text>
    <Text color={state.theme.muted}>
      {state.model} · context {formatNumber(context?.used_tokens)} /{" "}
      {formatNumber(context?.max_tokens)}
      {state.pendingApproval ? " · approval pending" : ""}
    </Text>
  </Box>
);
```

- [ ] **Step 4: Add Header component**

Create `tui/node/src/app/Header.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { ShellState } from "../state/types.ts";

function workspaceLabel(value: string): string {
  const parts = value.split("/").filter(Boolean);
  return parts.at(-1) ?? value;
}

export function Header({ state }: { state: ShellState }) {
  const session = state.sessionId ? `session ${state.sessionId}` : "session pending";
  const workspace = state.workspace ? workspaceLabel(state.workspace) : "workspace pending";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box justifyContent="space-between">
        <Text color={state.theme.accent} bold>
          mycli
        </Text>
        <Text color={state.theme.muted}>
          {state.model || "model pending"} · {state.themeName}
        </Text>
      </Box>
      <Text color={state.theme.muted}>
        {session} · {workspace}
      </Text>
    </Box>
  );
}
```

- [ ] **Step 5: Theme InputBox**

Modify `tui/node/src/app/InputBox.tsx` props:

```tsx
import type { ThemeTokens } from "../theme/types.ts";

theme: ThemeTokens;
```

Render placeholder and command hint:

```tsx
  const isCommand = value.startsWith("/");
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={turnRunning ? theme.warning : theme.accent}>{"> "}</Text>
        <Text>{value || "Type a message or /command"}</Text>
      </Box>
      {isCommand ? <Text color={theme.subtle}>local UI command or Python slash command</Text> : null}
    </Box>
  );
```

Update all `InputBox` callsites and tests to pass `theme={state.theme}`.

- [ ] **Step 6: Add Header to App**

Modify `tui/node/src/app/App.tsx`:

```tsx
import { Header } from "./Header.tsx";

// render before Transcript:
<Header state={state} />
```

- [ ] **Step 7: Run branded shell tests**

Run:

```bash
npm --prefix tui/node test -- test/status-input.test.tsx test/app.test.tsx test/input.test.tsx
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tui/node/src/app tui/node/test/status-input.test.tsx tui/node/test/app.test.tsx tui/node/test/input.test.tsx
git commit -m "Polish Node TUI header status and input" \
  -m "The shell now exposes the branded console identity through header, status, and input surfaces while keeping assistant content restrained." \
  -m "Constraint: Brand treatment must not add role cards or decorative transcript wrappers." \
  -m "Rejected: Large welcome card layout | terminal output should stay work-focused and compact." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: npm --prefix tui/node test -- test/status-input.test.tsx test/app.test.tsx test/input.test.tsx" \
  -m "Tested: npm --prefix tui/node run typecheck"
```

---

### Task 4: Tool Summary Formatter And Tool Rows

**Files:**
- Create: `tui/node/src/state/toolSummary.ts`
- Create: `tui/node/src/app/ToolRow.tsx`
- Modify: `tui/node/src/app/Transcript.tsx`
- Create: `tui/node/test/tool-summary.test.ts`
- Modify: `tui/node/test/app.test.tsx`

- [ ] **Step 1: Write failing tool summary tests**

Create `tui/node/test/tool-summary.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { formatToolSummary } from "../src/state/toolSummary.ts";

test("formats Read tool path from metadata", () => {
  assert.deepEqual(
    formatToolSummary({
      tool_name: "Read",
      metadata: { path: "pyproject.toml", duration_ms: 82 },
    }),
    { verb: "read", target: "pyproject.toml", status: "done", detail: "82ms" },
  );
});

test("formats Edit diff counts from metadata", () => {
  assert.deepEqual(
    formatToolSummary({
      tool_name: "Edit",
      metadata: { path: "src/app.tsx", additions: 14, deletions: 3 },
    }),
    { verb: "edit", target: "src/app.tsx", status: "done", detail: "+14 -3" },
  );
});

test("formats Bash command and exit code", () => {
  assert.deepEqual(
    formatToolSummary({
      tool_name: "Bash",
      metadata: { command: "pytest -q", exit_code: 0 },
    }),
    { verb: "bash", target: "pytest -q", status: "done", detail: "exit 0" },
  );
});

test("formats Grep query and match count", () => {
  assert.deepEqual(
    formatToolSummary({
      tool_name: "Grep",
      metadata: { query: "NodeTuiGateway", matches: 8 },
    }),
    { verb: "grep", target: "NodeTuiGateway", status: "done", detail: "8 matches" },
  );
});

test("falls back for unknown tools without throwing", () => {
  assert.deepEqual(
    formatToolSummary({ tool_name: "CustomTool", text: "custom target", metadata: {} }),
    { verb: "customtool", target: "custom target", status: "unknown" },
  );
});
```

- [ ] **Step 2: Run failing tool summary tests**

Run:

```bash
npm --prefix tui/node test -- test/tool-summary.test.ts
```

Expected: FAIL because `toolSummary.ts` does not exist.

- [ ] **Step 3: Add formatter input and output types**

Create `tui/node/src/state/toolSummary.ts`:

```ts
export type ToolSummaryInput = {
  tool_name?: unknown;
  text?: unknown;
  metadata?: unknown;
};

export type ToolSummary = {
  verb: string;
  target: string;
  status: "running" | "done" | "failed" | "unknown";
  detail?: string;
};

function metadataOf(input: ToolSummaryInput): Record<string, unknown> {
  return typeof input.metadata === "object" && input.metadata !== null
    ? (input.metadata as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statusFrom(metadata: Record<string, unknown>): ToolSummary["status"] {
  if (metadata.status === "running") {
    return "running";
  }
  if (metadata.status === "failed" || metadata.error === true) {
    return "failed";
  }
  if ("exit_code" in metadata || "duration_ms" in metadata || metadata.status === "done") {
    return "done";
  }
  return "unknown";
}
```

- [ ] **Step 4: Add concrete formatter logic**

Append to `tui/node/src/state/toolSummary.ts`:

```ts
export function formatToolSummary(input: ToolSummaryInput): ToolSummary {
  const metadata = metadataOf(input);
  const name = stringValue(input.tool_name) ?? "Tool";
  const normalized = name.toLowerCase();
  const status = statusFrom(metadata);
  const duration = numberValue(metadata.duration_ms);
  const durationDetail = duration === null ? undefined : `${duration}ms`;

  if (normalized === "read") {
    return {
      verb: "read",
      target: stringValue(metadata.path) ?? stringValue(input.text) ?? "file",
      status: status === "unknown" ? "done" : status,
      detail: durationDetail,
    };
  }
  if (normalized === "edit" || normalized === "write") {
    const additions = numberValue(metadata.additions);
    const deletions = numberValue(metadata.deletions);
    const detail =
      additions !== null || deletions !== null
        ? `+${additions ?? 0} -${deletions ?? 0}`
        : durationDetail;
    return {
      verb: normalized,
      target: stringValue(metadata.path) ?? stringValue(input.text) ?? "file",
      status: status === "unknown" ? "done" : status,
      detail,
    };
  }
  if (normalized === "bash") {
    const exitCode = numberValue(metadata.exit_code);
    return {
      verb: "bash",
      target: stringValue(metadata.command) ?? stringValue(input.text) ?? "command",
      status: exitCode === null ? status : exitCode === 0 ? "done" : "failed",
      detail: exitCode === null ? durationDetail : `exit ${exitCode}`,
    };
  }
  if (normalized === "grep") {
    const matches = numberValue(metadata.matches);
    return {
      verb: "grep",
      target: stringValue(metadata.query) ?? stringValue(input.text) ?? "pattern",
      status: status === "unknown" ? "done" : status,
      detail: matches === null ? durationDetail : `${matches} matches`,
    };
  }
  return {
    verb: normalized,
    target: stringValue(metadata.path) ?? stringValue(input.text) ?? "tool call",
    status,
    detail: durationDetail,
  };
}
```

- [ ] **Step 5: Add ToolRow component**

Create `tui/node/src/app/ToolRow.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { ToolSummary } from "../state/toolSummary.ts";
import type { ThemeTokens } from "../theme/types.ts";

export function ToolRow({ summary, theme }: { summary: ToolSummary; theme: ThemeTokens }) {
  const statusColor =
    summary.status === "failed"
      ? theme.error
      : summary.status === "running"
        ? theme.warning
        : summary.status === "done"
          ? theme.success
          : theme.muted;
  return (
    <Box marginLeft={2}>
      <Text color={statusColor}>{summary.verb}</Text>
      <Text color={theme.subtle}> - </Text>
      <Text color={theme.muted}>{summary.target}</Text>
      {summary.detail ? (
        <>
          <Text color={theme.subtle}> - </Text>
          <Text color={theme.subtle}>{summary.detail}</Text>
        </>
      ) : null}
    </Box>
  );
}
```

- [ ] **Step 6: Route tool rows in Transcript**

Modify `tui/node/src/app/Transcript.tsx` imports:

```tsx
import { ToolRow } from "./ToolRow.tsx";
import { formatToolSummary } from "../state/toolSummary.ts";
```

Inside `TranscriptRow`, before the default text row:

```tsx
  if (item.type === "tool_summary") {
    return (
      <ToolRow
        summary={formatToolSummary({
          tool_name: item.metadata.tool_name ?? item.metadata.toolName ?? item.text.split(/\s+/, 1)[0],
          text: item.text,
          metadata: item.metadata,
        })}
        theme={theme}
      />
    );
  }
```

Update `TranscriptRow` props to accept `theme`, and pass `theme={state.theme}` from `Transcript`.

- [ ] **Step 7: Run tool tests**

Run:

```bash
npm --prefix tui/node test -- test/tool-summary.test.ts test/app.test.tsx
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tui/node/src/state/toolSummary.ts tui/node/src/app/ToolRow.tsx tui/node/src/app/Transcript.tsx tui/node/test/tool-summary.test.ts tui/node/test/app.test.tsx
git commit -m "Render structured Node TUI tool rows" \
  -m "Tool activity now uses a pure summary formatter and dedicated row component, replacing sparse dot-prefixed rows with compact execution telemetry." \
  -m "Constraint: Tool summaries may format Python-provided metadata but must not invent runtime facts or redaction policy." \
  -m "Rejected: Build summaries inline in Transcript JSX | formatter behavior needs direct unit coverage." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: npm --prefix tui/node test -- test/tool-summary.test.ts test/app.test.tsx" \
  -m "Tested: npm --prefix tui/node run typecheck"
```

---

### Task 5: Themed Overlay, Command Output, And Notices

**Files:**
- Modify: `tui/node/src/app/Overlay.tsx`
- Create: `tui/node/src/app/CommandOutput.tsx`
- Create: `tui/node/src/app/SystemNotice.tsx`
- Modify: `tui/node/src/app/Transcript.tsx`
- Create: `tui/node/test/overlay-polish.test.tsx`

- [ ] **Step 1: Write failing overlay polish tests**

Create `tui/node/test/overlay-polish.test.tsx`:

```tsx
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
```

- [ ] **Step 2: Run failing overlay tests**

Run:

```bash
npm --prefix tui/node test -- test/overlay-polish.test.tsx
```

Expected: FAIL because `CommandOutput.tsx` and `SystemNotice.tsx` do not exist and `Overlay` lacks theme props.

- [ ] **Step 3: Update Overlay**

Modify `tui/node/src/app/Overlay.tsx`:

```tsx
import type { ThemeTokens } from "../theme/types.ts";

export function Overlay({
  overlay,
  theme,
  maxLines = 12,
}: {
  overlay: OverlayState;
  theme: ThemeTokens;
  maxLines?: number;
}) {
  if (!overlay.visible) {
    return null;
  }
  const visibleLines = overlay.lines.slice(0, maxLines);
  const hidden = Math.max(overlay.lines.length - visibleLines.length, 0);
  return (
    <Box borderStyle="round" borderColor={theme.border} flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={theme.accent} bold>
          {overlay.title}
        </Text>
        <Text color={theme.subtle}>overlay</Text>
      </Box>
      {visibleLines.map((line, index) => (
        <Text key={`${index}:${line}`} color={theme.text}>
          {line}
        </Text>
      ))}
      {hidden > 0 ? <Text color={theme.warning}>{hidden} more lines truncated</Text> : null}
      <Text color={theme.subtle}>Esc close</Text>
    </Box>
  );
}
```

- [ ] **Step 4: Add CommandOutput**

Create `tui/node/src/app/CommandOutput.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../theme/types.ts";

export function CommandOutput({ text, theme }: { text: string; theme: ThemeTokens }) {
  return (
    <Box marginLeft={2}>
      <Text color={theme.muted}>{text}</Text>
    </Box>
  );
}
```

- [ ] **Step 5: Add SystemNotice**

Create `tui/node/src/app/SystemNotice.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { TranscriptItemType } from "../state/types.ts";
import type { ThemeTokens } from "../theme/types.ts";

export function SystemNotice({
  text,
  type = "system_notice",
  theme,
}: {
  text: string;
  type?: TranscriptItemType;
  theme: ThemeTokens;
}) {
  const color = type === "error" ? theme.error : type === "warning" ? theme.warning : theme.subtle;
  return (
    <Box marginLeft={2}>
      <Text color={color}>{text}</Text>
    </Box>
  );
}
```

- [ ] **Step 6: Wire Transcript and App**

Modify `tui/node/src/app/App.tsx`:

```tsx
<Overlay overlay={state.overlay} theme={state.theme} />
```

Modify `tui/node/src/app/Transcript.tsx`:

```tsx
import { CommandOutput } from "./CommandOutput.tsx";
import { SystemNotice } from "./SystemNotice.tsx";

if (item.type === "command_output") {
  return <CommandOutput text={item.text} theme={theme} />;
}
if (item.type === "system_notice" || item.type === "warning" || item.type === "error") {
  return <SystemNotice text={item.text} type={item.type} theme={theme} />;
}
```

- [ ] **Step 7: Run overlay tests**

Run:

```bash
npm --prefix tui/node test -- test/overlay-polish.test.tsx test/app.test.tsx
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tui/node/src/app tui/node/test/overlay-polish.test.tsx
git commit -m "Polish Node TUI overlays and notices" \
  -m "Inspection commands now render in a themed overlay shell, and low-emphasis command/system rows have dedicated components." \
  -m "Constraint: Overlay content is Python-provided display data and must not enter model-visible history." \
  -m "Rejected: Full overlay scrollback in this slice | bounded content with truncation keeps the polish pass small." \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: npm --prefix tui/node test -- test/overlay-polish.test.tsx test/app.test.tsx" \
  -m "Tested: npm --prefix tui/node run typecheck"
```

---

### Task 6: Basic Markdown Rendering

**Files:**
- Create: `tui/node/src/app/MarkdownText.tsx`
- Modify: `tui/node/src/app/Transcript.tsx`
- Create: `tui/node/test/markdown-text.test.tsx`

- [ ] **Step 1: Write failing markdown renderer tests**

Create `tui/node/test/markdown-text.test.tsx`:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { MarkdownText } from "../src/app/MarkdownText.tsx";
import { THEMES } from "../src/theme/themes.ts";

test("renders inline code and bold as readable terminal text", () => {
  const { lastFrame } = render(
    <MarkdownText text="Project is **mycli** and entry is `mycli.cli.main:main`." theme={THEMES["deep-teal"]} />,
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
```

- [ ] **Step 2: Run failing markdown tests**

Run:

```bash
npm --prefix tui/node test -- test/markdown-text.test.tsx
```

Expected: FAIL because `MarkdownText.tsx` does not exist.

- [ ] **Step 3: Add narrow markdown parser**

Create `tui/node/src/app/MarkdownText.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import type { ThemeTokens } from "../theme/types.ts";

type Segment = { kind: "plain" | "code" | "bold"; text: string };

function inlineSegments(line: string): Segment[] {
  const segments: Segment[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  for (const match of line.matchAll(pattern)) {
    if (match.index > lastIndex) {
      segments.push({ kind: "plain", text: line.slice(lastIndex, match.index) });
    }
    const raw = match[0];
    if (raw.startsWith("`")) {
      segments.push({ kind: "code", text: raw.slice(1, -1) });
    } else {
      segments.push({ kind: "bold", text: raw.slice(2, -2) });
    }
    lastIndex = match.index + raw.length;
  }
  if (lastIndex < line.length) {
    segments.push({ kind: "plain", text: line.slice(lastIndex) });
  }
  return segments.length ? segments : [{ kind: "plain", text: line }];
}

function renderLine(line: string): { codeBlock: boolean; text: string; segments: Segment[] } {
  if (line.startsWith("- ")) {
    return { codeBlock: false, text: "", segments: inlineSegments(`• ${line.slice(2)}`) };
  }
  if (/^\d+\.\s+/.test(line)) {
    return { codeBlock: false, text: "", segments: inlineSegments(line) };
  }
  return { codeBlock: false, text: "", segments: inlineSegments(line) };
}
```

- [ ] **Step 4: Add renderer component**

Append to `tui/node/src/app/MarkdownText.tsx`:

```tsx
export function MarkdownText({ text, theme }: { text: string; theme: ThemeTokens }) {
  const lines = text.split("\n");
  let inCode = false;
  return (
    <Box flexDirection="column" marginLeft={2}>
      {lines.map((line, index) => {
        if (line.startsWith("```")) {
          inCode = !inCode;
          return null;
        }
        if (inCode) {
          return (
            <Text key={index} color={theme.code}>
              {line}
            </Text>
          );
        }
        const rendered = renderLine(line);
        return (
          <Text key={index} color={theme.text}>
            {rendered.segments.map((segment, segmentIndex) => (
              <Text
                key={`${index}:${segmentIndex}`}
                color={segment.kind === "code" ? theme.code : theme.text}
                bold={segment.kind === "bold"}
              >
                {segment.text}
              </Text>
            ))}
          </Text>
        );
      })}
    </Box>
  );
}
```

- [ ] **Step 5: Use MarkdownText for final assistant text only**

Modify `tui/node/src/app/Transcript.tsx`:

```tsx
import { MarkdownText } from "./MarkdownText.tsx";

if (item.type === "assistant_final") {
  return <MarkdownText text={item.text} theme={theme} />;
}
```

Keep `assistant_stream` in the existing plain text path.

- [ ] **Step 6: Run markdown tests**

Run:

```bash
npm --prefix tui/node test -- test/markdown-text.test.tsx test/app.test.tsx test/transcript.test.ts
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tui/node/src/app/MarkdownText.tsx tui/node/src/app/Transcript.tsx tui/node/test/markdown-text.test.tsx
git commit -m "Render basic markdown in final Node TUI answers" \
  -m "Final assistant answers now receive a narrow terminal markdown pass for inline code, bold, lists, and fenced code while streaming output remains plain text." \
  -m "Constraint: Markdown rendering must stay small and incremental enough for the current Ink shell." \
  -m "Rejected: Add a full markdown engine now | CommonMark coverage and table rendering are outside this polish slice." \
  -m "Confidence: medium" \
  -m "Scope-risk: moderate" \
  -m "Tested: npm --prefix tui/node test -- test/markdown-text.test.tsx test/app.test.tsx test/transcript.test.ts" \
  -m "Tested: npm --prefix tui/node run typecheck"
```

---

### Task 7: Integrated Branded Console Snapshot And Smoke

**Files:**
- Create: `tui/node/test/app-polish.test.tsx`
- Create: `docs/superpowers/reports/2026-05-27-node-tui-daily-ui-polish-smoke.md`

- [ ] **Step 1: Write integrated branded console test**

Create `tui/node/test/app-polish.test.tsx`:

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

  const { lastFrame } = render(<App state={state} />);
  const frame = lastFrame() ?? "";

  assert.match(frame, /mycli/);
  assert.match(frame, /deep-teal/);
  assert.match(frame, /read pyproject/);
  assert.match(frame, /read/);
  assert.match(frame, /pyproject\.toml/);
  assert.match(frame, /mycli\.cli\.main:main/);
  assert.doesNotMatch(frame, /USER|ASSISTANT|TOOL/);
});
```

- [ ] **Step 2: Run integrated Node tests**

Run:

```bash
npm --prefix tui/node test -- test/app-polish.test.tsx
npm --prefix tui/node test
npm --prefix tui/node run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run focused Python tests**

Run:

```bash
uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py -q
```

Expected: PASS.

- [ ] **Step 4: Run full static checks and Python suite**

Run:

```bash
uv run ruff check src tests
uv run mypy src/mycli
uv run pytest -q
```

Expected: PASS.

- [ ] **Step 5: Run scripted theme smoke**

Run:

```bash
SMOKE_HOME="$(mktemp -d)"
SESSION="node-tui-polish-scripted-smoke-$(date +%Y%m%d%H%M%S)"
SCRIPT='["请使用 Read 工具读取 pyproject.toml，然后用一句话回答项目名和 CLI 入口点。","/theme mono","/usage","/sessions","/quit"]'
HOME="$SMOKE_HOME" MYCLI_TUI_THEME=graphite MYCLI_NODE_TUI_SCRIPT="$SCRIPT" uv run mycli --node-tui --session "$SESSION"
```

Expected:

- exit code 0
- stderr contains `[node-tui] runtime.ready`, `[node-tui] turn.event`, and `[node-tui] turn.completed`
- `/theme mono` does not produce a Python `command.run` line in scripted logs
- `/usage`, `/sessions`, and `/quit` still run through Python `command.run`

- [ ] **Step 6: Run manual smoke**

Run:

```bash
MYCLI_TUI_THEME=deep-teal uv run mycli --session node-tui-polish-manual-smoke
```

Manual checklist:

```text
1. Header/status use the deep-teal theme.
2. /theme graphite changes the visible theme without a model turn.
3. /theme nope shows an error and keeps the current theme.
4. Submit: 请使用 Read 工具读取 pyproject.toml，然后用一句话回答项目名和 CLI 入口点。
5. Tool row is compact and structured.
6. Final answer renders inline code/readable markdown.
7. /usage and /sessions overlays use themed shell.
8. /clear clears visible transcript only.
9. /quit exits cleanly.
```

Expected: PASS.

- [ ] **Step 7: Write smoke report**

Create `docs/superpowers/reports/2026-05-27-node-tui-daily-ui-polish-smoke.md`:

```markdown
# Node TUI Daily UI Polish Smoke

## Scope

- Branded Console theme system.
- Node-local `/theme` and `/clear`.
- Structured tool rows.
- Themed overlays, status, input, notices.
- Basic final-answer markdown rendering.

## Verification

| Command | Result |
| --- | --- |
| `npm --prefix tui/node test` | PASS |
| `npm --prefix tui/node run typecheck` | PASS |
| `uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py -q` | PASS |
| `uv run ruff check src tests` | PASS |
| `uv run mypy src/mycli` | PASS |
| `uv run pytest -q` | PASS |
| `MYCLI_TUI_THEME=graphite MYCLI_NODE_TUI_SCRIPT='["请使用 Read 工具读取 pyproject.toml，然后用一句话回答项目名和 CLI 入口点。","/theme mono","/usage","/sessions","/quit"]' uv run mycli --node-tui --session <scripted-session>` | PASS |
| `MYCLI_TUI_THEME=deep-teal uv run mycli --session node-tui-polish-manual-smoke` | PASS |

## Manual Notes

- Default `deep-teal` theme rendered correctly.
- `/theme graphite` changed Node UI without a model turn.
- Invalid theme showed a local warning.
- Tool row rendered as structured execution telemetry.
- `/usage` and `/sessions` rendered themed overlays.
- `/clear` cleared visible Node transcript only.
- `/quit` exited cleanly.
```

- [ ] **Step 8: Commit**

```bash
git add tui/node docs/superpowers/reports/2026-05-27-node-tui-daily-ui-polish-smoke.md
git commit -m "Verify Node TUI daily polish" \
  -m "The branded console polish is complete and verified across Node tests, Python focused tests, static checks, full pytest, scripted smoke, and manual TTY smoke." \
  -m "Constraint: UI polish must preserve Python runtime authority and Node-only theme state." \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: npm --prefix tui/node test" \
  -m "Tested: npm --prefix tui/node run typecheck" \
  -m "Tested: uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py -q" \
  -m "Tested: uv run ruff check src tests" \
  -m "Tested: uv run mypy src/mycli" \
  -m "Tested: uv run pytest -q" \
  -m "Tested: scripted and manual Node TUI polish smokes"
```

---

## Self-Review Checklist

- Spec coverage:
  - Theme system: Tasks 1 and 2.
  - Branded console surfaces: Tasks 3, 5, and 7.
  - Transcript hierarchy: Tasks 3, 4, 5, and 6.
  - Tool activity rows: Task 4.
  - Productized overlays: Task 5.
  - Status/input improvements: Task 3.
  - Basic markdown: Task 6.
  - Minimal protocol changes: no Python gateway task is included.
  - Node-local `/theme` interception: Task 2.
  - `ToolSummary.detail` input logic: Task 4.
- Non-goals preserved:
  - No theme editor.
  - No custom theme files.
  - No transcript search.
  - No complex scrollback engine.
  - No Python runtime/session/tool ownership changes.
- Verification:
  - Run Node tests and typecheck before Python full suite.
  - Run scripted smoke before manual smoke.
  - Do not claim `/theme` is Node-local until scripted logs and manual smoke confirm it does not call Python `command.run`.
