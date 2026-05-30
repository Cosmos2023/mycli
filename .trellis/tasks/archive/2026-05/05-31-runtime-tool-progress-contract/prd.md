# Runtime Tool Progress Contract

## Goal

Add the missing Hermes-like `tool.progress` runtime/TUI contract channel so
tool lifecycle events are no longer limited to start and terminal outcomes.

## Context

- mycli already emits execution-derived `tool.start`, `tool.complete`, and
  `tool.failed` events.
- Hermes-like parity includes `tool.start / tool.progress / tool.complete`.
- The current lifecycle sink has a real, safe progress point between start and
  finish: the local tool has begun executing, but no result is known yet.
- This slice should establish the runtime contract first; TUI rendering can
  consume it in a later slice.

## Research References

- [`research/runtime-tool-progress-contract.md`](research/runtime-tool-progress-contract.md)
  documents the existing lifecycle path and recommended payload.

## Requirements

- Emit a runtime stream event with kind `tool_progress` during real local tool
  execution, after `tool_start` and before `tool_complete` / `tool_failed`.
- Include payload fields:
  - `tool_id`
  - `call_id`
  - `name`
  - `stage`
  - `message`
  - optional `context`
  - optional `args_preview`
- Use `stage="executing"` for this first progress point.
- Keep progress detail bounded with existing lifecycle preview behavior.
- Map `RuntimeStreamEvent(kind="tool_progress")` to Node gateway notification
  `tool.progress`.
- Do not emit a generic `turn.event` for `tool_progress`.
- Do not change provider transcript content, model-visible tool schemas,
  stable request-shape inputs, trace persistence, or final activity events.
- Update the runtime/TUI gateway spec to document `tool.progress`.
- Do not change Node TUI reducer/rendering behavior in this slice.
- Do not merge into `main`.

## Non-Goals

- Do not add percent progress or per-tool callback APIs.
- Do not add TUI rendering for `tool.progress`.
- Do not add extension/ACP consumers.
- Do not change tool result summaries or final transcript rows.

## Acceptance Criteria

- Tool execution unit tests prove lifecycle event order is
  `tool_start`, `tool_progress`, terminal event.
- Gateway unit tests prove `tool_progress` maps to `tool.progress` and is not
  forwarded as `turn.event`.
- Agent runtime tests prove real tool execution forwards progress through
  `handle_user_turn(..., stream_sink=...)`.
- Runtime/TUI gateway spec documents the new payload and validation behavior.
- Focused Python tests pass.
- Trellis task is archived and work is committed only on
  `feature/mycli-runtime-tool-progress-contract`.
