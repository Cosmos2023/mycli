# Codex Alignment P10 Tool Runtime Lifecycle Unification

## Objective

Implement P10 from `docs/parity/codex-alignment-phases-p9-p13.md`: standardize tool runtime lifecycle diagnostics across tool-like actions that already flow through `ToolExecutionService`.

P10 builds on P9 runtime policy. It does not rewrite context assembly, provider request shape, cache policy, or compact/rehydration.

## Problem

`ToolExecutionService` already emits stream lifecycle events:

- `tool_start`
- `tool_progress`
- `tool_complete`
- `tool_failed`

It also records final `tool_execution` trace rows and turn items. But lifecycle events themselves are not persisted as a standardized trace stream, so doctor cannot detect incomplete lifecycle chains such as a start without terminal event, duplicate terminal rows, or malformed lifecycle rows.

Contributed-tool registry lifecycle (`tool_lifecycle`) exists, but that describes contribution exposure state, not per-call execution lifecycle.

## Requirements

1. Define a bounded per-call tool lifecycle trace contract.
2. Emit lifecycle trace rows from `ToolExecutionService` for:
   - `planned`
   - `policy_checked`
   - `started`
   - `progress`
   - `completed`
   - `failed`
   - `denied`
   - `needs_approval`
   - `interrupted`
3. Keep existing stream events and `tool_execution` rows backward compatible.
4. Include stable bounded fields:
   - tool name
   - call id / lifecycle id
   - phase
   - status
   - argument count / argument keys
   - policy decision when available
   - duration for terminal events when available
   - error kind when available
5. Do not include raw args, raw command text, raw tool output, prompt text, local file contents, headers, or secrets.
6. Doctor must summarize lifecycle integrity:
   - missing trace directory -> ok
   - no lifecycle rows -> ok
   - valid complete lifecycles -> ok
   - start without terminal -> warning
   - terminal without start -> warning
   - duplicate terminal -> warning
   - malformed phase/status -> warning

## Non-goals

- Do not implement a new long-running worker system.
- Do not add cancellation UI/TUI productization.
- Do not change provider request shape.
- Do not change compact or rehydration.
- Do not remove existing `tool_execution` diagnostics.
- Do not remove contributed tool exposure lifecycle diagnostics.

## Acceptance Criteria

- Tool lifecycle trace contract has unit tests.
- `ToolExecutionService` emits lifecycle trace rows for success, failure, policy denial, needs approval, and interruption.
- Doctor lifecycle integrity check has unit tests.
- Existing `tool_execution` diagnostics continue to pass.
- context / subagent / MCP / plugin / hook smoke do not regress.
- Quality gates pass:
  - `uv run ruff check src tests evaluation`
  - `uv run mypy src/mycli`
  - `uv run pytest -q`

## Compact Boundary

P10 must not modify compact or compact rehydration implementation. Any final report must include a diff audit proving those files were not touched.
