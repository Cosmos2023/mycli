# PRD: Runtime Interrupted Turn Diagnostics

## Objective

Make interrupted runtime turns diagnosable in local trace/log output when mycli preserves suspended state for resume.

## Scope

Implement:

- A local `turn_interrupted` trace event from `_finalize_interrupted_turn()`.
- A matching workspace log entry.
- Payload fields:
  - `session_id`
  - `turn_id`
  - `stop_reason`
  - `suspend_reason`
  - `saved_state`
  - `message_count`
- Tests that force `KeyboardInterrupt` and verify:
  - turn status is `INTERRUPTED`
  - suspended turn is saved
  - trace/log diagnostics are emitted

Do not implement:

- real OS signal handling changes
- TUI visual changes
- provider transcript changes
- MCP/skills/subagent/ACP productization

## Acceptance Criteria

- Interrupted turn behavior remains compatible with existing resume logic.
- `turn_interrupted` appears in `TraceService.load(session_id)`.
- `turn_interrupted` appears in `agent.log`.
- Focused tests pass:
  - relevant `tests/unit/application/test_turn_executor.py` or integration runtime tests
  - ruff on changed files

## Risks

- Interrupts can happen at multiple phases. This slice covers the centralized finalizer, not every call site individually.
