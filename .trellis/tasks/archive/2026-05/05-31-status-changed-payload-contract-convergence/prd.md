# Status Changed Payload Contract Convergence

## Goal

Make `status.changed` a real machine-readable runtime/TUI contract instead of
an advertised event with an empty payload schema.

## Requirements

- Define the Python manifest payload schema for `status.changed`.
- Mirror the same required fields and property names in the Node protocol
  contract map.
- Keep `status.changed` semantics aligned with the existing gateway payload:
  session identity, workspace/model/provider metadata, context window metrics,
  and pending-state booleans.
- Do not change runtime behavior unless schema work exposes an existing drift.
- Do not productize MCP, skills, subagent/multi-agent, or ACP.
- Do not merge into `main`.

## Non-Goals

- Do not introduce a runtime payload validator.
- Do not redesign the status snapshot shape.
- Do not replace `status.update`; `status.changed` remains the snapshot event,
  while `status.update` remains the turn-status/status-line event.

## Acceptance Criteria

- Python `gateway_event_payload_schemas()["status.changed"]` has required
  fields and properties matching `_status_payload()`.
- Node `GATEWAY_EVENT_PAYLOAD_CONTRACTS["status.changed"]` matches the Python
  manifest schema.
- Existing Node manifest parity tests pass.
- Focused Python contract tests pass.
- Relevant lint/typecheck/tests pass.
- Trellis task is archived and committed on the feature branch.
