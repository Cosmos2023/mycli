# Native Resume Transition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume saved sessions without retaining the selector, joining terminal rows, or omitting loaded history from native scrollback.

**Architecture:** Mark the selected transcript for one full presentation after the async session load completes. Re-anchor native full redraws to the tracked viewport origin before replacing rows, while preserving terminal scrollback.

**Tech Stack:** TypeScript, Node.js test runner, vendored pi-tui differential renderer

---

### Task 1: Reproduce Resume Transition Failures

**Files:**
- Test: `tui/mycli-shell/test/shell-app.test.ts`
- Test: `tui/mycli-shell/test/tui-native-scrollback.test.ts`

- [ ] Add a session-selector test whose selection callback replaces state with a
  long transcript. Clear captured terminal output before selection, then verify
  the output contains the oldest resumed item, excludes `Resume Session`, and
  contains no clear-screen sequence.
- [ ] Add a renderer test that creates a native terminal with content taller than
  its viewport, changes an off-screen early row, and verifies the full-redraw
  buffer moves to viewport row zero and column zero before writing replacement
  content.
- [ ] Run both focused tests and verify they fail for the missing resume
  presentation and missing redraw anchor.

### Task 2: Present Loaded History and Anchor Full Redraws

**Files:**
- Modify: `tui/mycli-shell/src/shell-runtime.ts`
- Modify: `tui/mycli-shell/src/tui-core/tui.ts`

- [ ] After `onSessionSelect` resolves, call
  `this.transcriptViewport.renderFullNext()` and `this.ui.requestRender()`.
- [ ] In `fullRender(clear)`, when `clear` and `terminal.nativeScrollback` are true,
  move upward by `hardwareCursorRow - prevViewportTop`, emit `\r`, and clear each
  row before writing it. Keep initial renders and non-native clearing unchanged.
- [ ] Run focused tests, the complete Node TUI suite, TypeScript typecheck, Python
  tests, Ruff, and mypy.
- [ ] Commit only the spec, plan, implementation, and regression tests.

