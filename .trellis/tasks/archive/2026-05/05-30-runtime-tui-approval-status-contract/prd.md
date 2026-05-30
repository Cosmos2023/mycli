# Runtime TUI Approval/Status Contract

## Goal

Implement the first runtime-to-TUI contract slice toward Hermes-like gateway parity: explicit approval and live status events that the Node TUI can consume without inferring runtime state from transcript text.

## Context

- Parent analysis task: `.trellis/tasks/05-30-runtime-to-tui-contract-gap-analysis`.
- Reference research: `research/runtime-to-tui-contract-gaps.md`.
- Hermes target semantics include separate channels for message streaming, reasoning, tool lifecycle, approval/clarify gates, status updates, and terminal turn outcomes.
- This task is intentionally P1 only. It validates the shared event-contract direction without migrating the whole gateway envelope yet.

## Requirements

- Preserve the existing JSON-RPC transport and current events for backward compatibility.
- Add Hermes-like event names and payloads for:
  - `approval.request`
  - `approval.respond`
  - `status.update`
- Expose turn state values at the gateway/TUI boundary:
  - `running`
  - `waiting_approval`
  - `completed`
  - `failed`
  - `interrupted`
- When a runtime turn produces a pending decision, emit an actionable approval event with:
  - stable `decision_id`
  - human-readable `preview`
  - optional `reason`
  - available response options matching the existing decision model
  - associated `client_turn_id`
- Accept approval responses through the gateway using the Hermes-like `approval.respond` method while keeping existing `decision.resolve` compatibility if present.
- Emit live `status.update` events for turn start, waiting approval, completion, failure, and interruption.
- Update Node TUI protocol types/reducer so `ApprovalPrompt` receives actionable approval details from gateway events.
- Update `RunningActivity` or equivalent state so live status text/kind can be rendered instead of hardcoded "Thinking" where the new status exists.
- Keep event names and payload shape forward-compatible with later P2-P5 work:
  - tool lifecycle
  - assistant/reasoning stream
  - typed envelope
  - clarify/terminal turn status

## Non-Goals

- Do not migrate the entire transport to Hermes' `method: "event"` envelope in this task.
- Do not implement `tool.start/tool.progress/tool.complete`.
- Do not implement `message.delta/message.complete` or `thinking.delta/reasoning.delta`.
- Do not change model/provider runtime behavior.
- Do not copy Hermes code.

## Acceptance Criteria

- Python gateway emits `approval.request` and `status.update` payloads in the P1 cases.
- Python gateway accepts `approval.respond` and resolves the pending decision.
- Existing `decision.resolve` behavior remains compatible unless tests prove it was unused or invalid.
- Node TUI reducer stores actionable pending approval state from `approval.request`.
- Node TUI clears approval state when approval is resolved or status indicates no pending approval.
- Node TUI stores live status from `status.update`.
- Tests cover:
  - gateway approval request payload
  - gateway approval response compatibility
  - status update payloads for running/waiting/completed/failed
  - reducer handling for approval/status
- Existing Python tests for node TUI gateway and relevant Node tests pass.

## Definition of Done

- Runtime/TUI source changes are limited to this P1 contract slice.
- Tests are added or updated for both Python gateway and TypeScript reducer/protocol behavior.
- `pytest` passes for relevant Python tests.
- Node TUI test/typecheck command is run if available; otherwise the missing command is reported.
