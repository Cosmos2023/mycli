# Current State

## Existing Behavior

- Runtime turn failures are persisted as `TurnStatus.FAILED` with a
  `StopReason`.
- Gateway turn-worker failures already emit `turn.failed`, `turn.status`, and
  `status.update` for TUI clients.
- Model/runtime exceptions write redacted raw error payloads under the local log
  root and add user-facing `error_details`.
- Interrupted turns already append local `turn_interrupted` trace/log
  diagnostics, and doctor can summarize several other diagnostic trace kinds.

## Gap

Failed non-interrupted turns do not have a single local `turn_failed` trace/log
row. Post-mortem diagnostics require correlating turn records, error payloads,
model stream diagnostics, and gateway events. Hermes-like local foundations
should expose a bounded failure taxonomy in the same local observability plane
used for interrupts, tools, approvals, clarification, and model stream
diagnostics.

## Chosen Slice

Add local `turn_failed` trace/log diagnostics from the runtime failure
finalizer, then summarize those rows in doctor. Keep the payload bounded and
diagnostic-only; do not change gateway event shapes, provider transcript replay,
TUI rendering, MCP, skills, subagents, or ACP.
