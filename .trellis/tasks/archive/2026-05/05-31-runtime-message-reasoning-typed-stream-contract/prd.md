# Runtime Message Reasoning Typed Stream Contract

## Goal

Add the next Hermes-like runtime-to-TUI contract slice for assistant text and
reasoning streams. The gateway should emit typed notifications alongside the
existing compatibility `turn.event` stream.

## Context

- Previous slices added approval/status and tool lifecycle channels.
- mycli currently streams model output through generic `turn.event` with phases:
  - `assistant_delta` for text deltas
  - `reasoning` for reasoning chunks
  - `model_completed` for model completion metadata
- Hermes uses separate channels such as `message.delta`, `message.complete`,
  `thinking.delta`, and `reasoning.delta`.
- This task is runtime/gateway only. TUI consumption can be a following TUI
  worktree slice.

## Requirements

- Preserve existing `turn.event` notifications exactly enough for current Node
  TUI compatibility.
- Add gateway notifications during a running turn:
  - `message.delta` for assistant text deltas
  - `message.complete` for stream/model completion metadata
  - `reasoning.delta` for reasoning chunks
  - optionally `thinking.delta` as a compatibility alias for reasoning chunks
- Typed payloads must include `client_turn_id`.
- `message.delta` payload must include bounded raw `text`.
- `reasoning.delta` / `thinking.delta` payloads must include bounded raw `text`.
- `message.complete` payload should include `client_turn_id` and model stream
  metadata; it may omit final assistant text when only model-completion metadata
  is available from the stream event. Final assistant text remains authoritative
  in `turn.completed.assistant_message` for this slice.
- Do not change provider transcript construction, request-shape/cache inputs,
  session persistence, or tool execution semantics.
- Keep sink failure behavior non-fatal.
- Add tests proving:
  - `ModelTurnRequester` still emits stream events in order to the sink.
  - `NodeTuiGateway` emits typed message/reasoning notifications and still
    emits compatibility `turn.event` notifications.
  - Existing gateway ordered event behavior remains compatible.

## Non-Goals

- Do not implement Node TUI reducer/rendering consumption of typed message or
  reasoning events in this task.
- Do not remove or rename `turn.event`.
- Do not migrate to a unified Hermes `method: "event"` envelope.
- Do not implement reasoning availability/final reasoning recovery.
- Do not merge into `main`.

## Acceptance Criteria

- Gateway emits `message.delta` for `RuntimeStreamEvent(kind="text_delta")`.
- Gateway emits `reasoning.delta` and `thinking.delta` for
  `RuntimeStreamEvent(kind="reasoning")`.
- Gateway emits `message.complete` for `RuntimeStreamEvent(kind="completed")`.
- Existing `turn.event` compatibility notifications are still emitted.
- Runtime TUI contract spec documents the typed stream channels and compatibility
  rule.
- Relevant Python tests, ruff, and mypy pass.
- Work is committed and archived on `feature/mycli-runtime-capabilities` only.
