# Codex-Style Stream Retry Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render retryable model-stream failures as a transient Codex-style `Reconnecting... n/5` status with bounded error details while preserving running-turn behavior.

**Architecture:** Extend the existing `stream_retrying` lifecycle event instead of adding transcript items. Carry a public `ModelResponseError` message through the Python gateway, retain structured retry state in the TypeScript adapter, and render it through the existing turn activity component using a status kind rather than parsing display text.

**Tech Stack:** Python 3.13, pytest, TypeScript, Node test runner, custom terminal UI components.

---

### Task 1: Carry retry details through the Python event pipeline

**Files:**
- Modify: `src/mycli/application/runtime/turn_executor.py:2038-2061`
- Modify: `tests/unit/application/test_turn_recovery_and_budget.py:500-540`
- Modify: `tests/unit/cli/node_tui/test_gateway.py:640-670`

- [ ] **Step 1: Add failing executor and gateway assertions**

Extend the existing retry lifecycle tests:

```python
retry_event = next(event for event in stream_events if event.kind == "stream_retrying")
assert retry_event.metadata["additional_details"] == "temporary stream failure"
```

and:

```python
metadata={
    "attempt": 2,
    "max_retries": 5,
    "delay_seconds": 0.4,
    "additional_details": "Idle timeout waiting for SSE",
}
```

Assert that `stream.retrying` forwards `additional_details` unchanged.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
uv run pytest -q \
  tests/unit/application/test_turn_recovery_and_budget.py \
  tests/unit/cli/node_tui/test_gateway.py \
  -k 'resets_partial_stream_before_reconnecting or forwards_transient_stream_retry_lifecycle'
```

Expected: failure because executor retry metadata does not include `additional_details`.

- [ ] **Step 3: Add the public error message to retry metadata**

In `_emit_stream_retry_lifecycle`, emit only the exception's public message and cap it before transport:

```python
detail = " ".join(str(exc).split())[:2000]
metadata={
    **action.metadata,
    "max_retries": action.metadata.get("max_attempts", 0),
    **({"additional_details": detail} if detail else {}),
}
```

The gateway already spreads event metadata into the event payload, so no new gateway branch is required.

- [ ] **Step 4: Run focused Python tests**

Run the command from Step 2. Expected: both selected tests pass.

### Task 2: Preserve structured retry status in the runtime adapter

**Files:**
- Modify: `tui/mycli-shell/src/model.ts:227-250`
- Modify: `tui/mycli-shell/src/adapters/runtime-state.ts:90-150`
- Modify: `tui/mycli-shell/src/adapters/runtime-state.ts:650-675`
- Modify: `tui/mycli-shell/test/runtime-state.test.ts:1390-1420`

- [ ] **Step 1: Add failing projection and recovery assertions**

Extend the reconnect test to send `additional_details`, then assert:

```typescript
assert.equal(shell.footer.liveStateKind, "reconnecting");
assert.equal(shell.footer.liveStateDetail, "Idle timeout waiting for SSE");
assert.equal(shell.transcript?.some((block) => block.kind === "message" && block.message.text.includes("Idle timeout")), false);
```

After `stream.recovered`, assert the previous live status is restored:

```typescript
state = reduceRuntimeEvent(state, "stream.recovered", { client_turn_id: "c1" });
assert.equal(state.liveStatus?.text, "Thinking");
assert.equal(projectRuntimeState(state).footer.liveStateDetail, undefined);
```

- [ ] **Step 2: Run the adapter test and verify it fails**

Run:

```bash
cd tui/mycli-shell
node --test --import tsx --test-name-pattern='rolls back partial assistant output while reconnecting' test/runtime-state.test.ts
```

Expected: failure because footer retry kind/detail and restore state do not exist.

- [ ] **Step 3: Add structured status fields**

Add footer fields:

```typescript
liveState?: string;
liveStateKind?: string;
liveStateDetail?: string;
```

Add a typed restore slot to `RuntimeShellState`:

```typescript
retryRestoreStatus: RuntimeShellState["liveStatus"];
```

Initialize it to `null`. On the first `stream.retrying`, retain the current non-reconnecting status and set:

```typescript
liveStatus: {
  state: "running",
  kind: "reconnecting",
  text,
  message: stringValue(params.additional_details) ?? undefined,
},
```

On `stream.recovered`, restore `retryRestoreStatus` or `{ state: "running", kind: "running", text: "Running" }`, then clear the restore slot. Project `kind` and `message` into the footer.

- [ ] **Step 4: Run runtime adapter tests**

Run:

```bash
cd tui/mycli-shell
node --test --import tsx test/runtime-state.test.ts
```

Expected: all runtime-state tests pass.

### Task 3: Render retry status and keep keyboard semantics running

**Files:**
- Modify: `tui/mycli-shell/src/shell-runtime.ts:110-145`
- Modify: `tui/mycli-shell/src/shell-runtime.ts:1177-1185`
- Modify: `tui/mycli-shell/src/shell-runtime.ts:1384-1392`
- Modify: `tui/mycli-shell/src/shell-runtime.ts:1590-1600`
- Modify: `tui/mycli-shell/test/shell-app.test.ts:900-960`
- Modify: `tui/mycli-shell/test/shell-app.test.ts:3690-3730`

- [ ] **Step 1: Add failing render and interaction tests**

Create shell state with:

```typescript
footer: {
  ...sampleState().footer,
  liveState: "Reconnecting... 1/5",
  liveStateKind: "reconnecting",
  liveStateDetail: "Idle timeout waiting for model stream",
},
```

Assert the rendered output contains both lines, every row is narrower than the terminal width, and pressing Esc invokes `onInterrupt` once.

- [ ] **Step 2: Run the shell tests and verify they fail**

Run:

```bash
cd tui/mycli-shell
node --test --import tsx --test-name-pattern='reconnecting' test/shell-app.test.ts
```

Expected: failure because reconnecting is treated as idle and has no detail rendering.

- [ ] **Step 3: Make turn activity status-aware**

Pass footer status into `TurnActivityComponent`:

```typescript
type TurnActivityStatus = {
  text: string;
  kind?: string;
  detail?: string;
};
```

For `kind === "reconnecting"`, render an animated first line with `status.text` and a dim, indented detail capped to two visual rows. Keep the existing elapsed `Thinking` display for other running kinds.

Use `footer.liveStateKind` for `isRunningLiveState` and `isTurnRunning`, with existing text matching as a compatibility fallback. This preserves Esc, steer, follow-up, timer, and footer behavior while reconnecting.

- [ ] **Step 4: Run shell tests and typecheck**

Run:

```bash
cd tui/mycli-shell
node --test --import tsx test/shell-app.test.ts
npm run typecheck
```

Expected: all shell tests and typecheck pass.

### Task 4: Verify the full retry path

**Files:**
- Verify only the files changed in Tasks 1-3.

- [ ] **Step 1: Run the complete frontend suite**

```bash
cd tui/mycli-shell
npm test
npm run typecheck
```

Expected: zero failures.

- [ ] **Step 2: Run focused Python retry and gateway suites**

```bash
uv run pytest -q \
  tests/unit/application/test_turn_recovery_and_budget.py \
  tests/unit/cli/node_tui/test_gateway.py \
  -k 'retry or stream_retry'
```

Expected: zero failures.

- [ ] **Step 3: Check the patch**

```bash
git diff --check -- \
  src/mycli/application/runtime/turn_executor.py \
  tests/unit/application/test_turn_recovery_and_budget.py \
  tests/unit/cli/node_tui/test_gateway.py \
  tui/mycli-shell/src/model.ts \
  tui/mycli-shell/src/adapters/runtime-state.ts \
  tui/mycli-shell/src/shell-runtime.ts \
  tui/mycli-shell/test/runtime-state.test.ts \
  tui/mycli-shell/test/shell-app.test.ts
```

Expected: no output.
