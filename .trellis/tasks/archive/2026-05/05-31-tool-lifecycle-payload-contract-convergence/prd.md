# Tool Lifecycle Payload Contract Convergence

## Goal

Make tool lifecycle events a stronger Hermes-like runtime client contract by
advertising `client_turn_id` as required for every `tool.*` payload the gateway
emits.

## Requirements

- `tool.start`, `tool.progress`, `tool.complete`, and `tool.failed` schemas
  must require `client_turn_id`.
- TypeScript `GATEWAY_EVENT_PAYLOAD_CONTRACTS` must match the Python manifest.
- Python contract tests must lock the required field lists for all four tool
  lifecycle events.
- Existing gateway and reducer behavior must continue to pass.
- Do not change runtime event ordering or tool execution behavior.
- Do not productize MCP, skills, subagent/multi-agent, or ACP.
- Do not merge into `main`.

## Non-Goals

- Do not add a runtime schema validator.
- Do not redesign the tool timeline reducer.
- Do not add new tool execution features or approval modes in this slice.

## Acceptance Criteria

- Python contract tests prove every `tool.*` lifecycle schema requires
  `client_turn_id`.
- Node manifest parity test passes against the live Python manifest.
- Relevant ruff, mypy, focused pytest, gateway tests, reducer tests, and Node
  typecheck pass.
- Trellis task is archived and committed on the feature branch.
