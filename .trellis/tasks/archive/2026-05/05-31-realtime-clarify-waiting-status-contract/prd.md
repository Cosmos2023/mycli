# Realtime Clarification Waiting Status Contract

## Problem

The runtime/TUI contract has a first-class `waiting_clarification` state, but
the gateway only emits that status after the turn worker returns. A
`clarify.request` notification can reach the Node TUI before any status event
marks the turn as waiting for user clarification.

Hermes-like gateway clients should not need to infer the waiting state from
transcript rows or wait for terminal compatibility events.

## Scope

In scope:

- Emit normalized `turn.status` and `status.update` for `waiting_clarification`
  when forwarding a runtime `clarify_request` stream event.
- Keep existing `clarify.request`, `runtime.event`, and `turn.completed`
  compatibility behavior.
- Add gateway tests for realtime status ordering and payloads.

Out of scope:

- Changing clarification persistence in `AgentRuntime`.
- Changing Node reducer behavior unless tests show it is required.
- Changing approval behavior.
- Productizing MCP, skills, subagent/multi-agent, or ACP.

## Requirements

- `clarify.request` stream forwarding must still include bounded request
  metadata and runtime event mirror.
- The gateway must emit `turn.status` with:
  - `state: "waiting_clarification"`
  - `terminal: false`
  - matching `client_turn_id`
- The gateway must emit `status.update` with:
  - `state: "waiting_clarification"`
  - `kind: "waiting_clarification"`
  - matching `client_turn_id`
- Waiting clarification turns must not emit final-text `message.complete`.

## Acceptance Criteria

- Gateway unit tests cover realtime clarification waiting status.
- Existing gateway clarification and ordered event tests still pass.
- `uv run pytest tests/unit/cli/node_tui/test_gateway.py -q` passes.
- `uv run ruff check src/mycli/cli/node_tui/gateway.py tests/unit/cli/node_tui/test_gateway.py` passes.
- Trellis task is archived and committed.
