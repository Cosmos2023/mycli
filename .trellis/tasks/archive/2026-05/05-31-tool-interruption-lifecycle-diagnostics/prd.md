# Tool Interruption Lifecycle Diagnostics

## Problem

`mycli` has turn-level interrupted diagnostics, but a `KeyboardInterrupt` raised
while a tool is executing can skip the normal tool outcome path. Users and
future TUI/extension clients can see that the turn was interrupted, but not
which tool was running or how the tool lifecycle ended.

Hermes-agent is the maturity reference only. Do not copy Hermes code.

## Scope

Baseline branch: `feature/mycli-foundation-hardening-audit`

Default integration policy: do not merge to `main`.

This slice covers Tool / approval / safety foundation by making tool execution
interruptions observable without swallowing the interrupt.

## Requirements

- In `ToolExecutionService.execute_tool_call()`, when `tool_router.execute(...)`
  raises `KeyboardInterrupt`:
  - emit the normal failed tool outcome path before re-raising
  - append a `TOOL_RESULT` turn item with failed metadata
  - emit lifecycle events in order: `tool_start`, `tool_progress`, `tool_failed`
  - append a local `tool_execution` trace row with:
    - `success=false`
    - `status=failed`
    - `error_kind=tool_interrupted`
    - stable `tool_call_id`
  - preserve bounded summary/error text
  - re-raise the original `KeyboardInterrupt`
- Existing turn-level interrupt handling remains responsible for saving
  suspended turn state and emitting `turn_interrupted`.
- File-history snapshots must be discarded/finalized consistently with a failed
  tool outcome.

## Acceptance Criteria

- Unit test proves interrupted tool execution emits failed lifecycle events,
  turn item metadata, and trace diagnostics, then re-raises `KeyboardInterrupt`.
- Unit test proves file-history snapshots are not retained for interrupted
  file mutation tools.
- Focused checks pass:
  - `uv run pytest tests/unit/application/test_tool_execution_service.py -q`
  - `uv run ruff check src/mycli/application/runtime/tools/tool_execution_service.py tests/unit/application/test_tool_execution_service.py`
  - `uv run mypy src/mycli/application/runtime/tools/tool_execution_service.py`
- Trellis research, PRD, implementation context, check context, and check
  results are present.
- Task is archived after verification.

## Non-goals

- No OS signal handling changes.
- No async tool cancellation API.
- No parallel batch cancellation semantics.
- No TUI rendering changes.
- No approval policy changes.
- No MCP, skills, subagent/multi-agent, or ACP productization.
- No merge to `main`.
