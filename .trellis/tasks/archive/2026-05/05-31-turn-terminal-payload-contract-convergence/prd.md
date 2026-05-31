# Turn Terminal Payload Contract Convergence

## Goal

Make terminal turn events discoverable as stable runtime client contracts by
aligning `turn.completed` and `turn.status` schemas with the payloads the
gateway already emits.

## Requirements

- `turn.completed` manifest schema must require the stable fields emitted by
  `_turn_completed_payload()`.
- TypeScript `GATEWAY_EVENT_PAYLOAD_CONTRACTS["turn.completed"]` must match
  the Python manifest schema.
- Python tests must lock the `turn.completed` required field list and the
  `turn.status` terminal/waiting state taxonomy.
- Existing Node manifest parity tests must pass.
- Do not change runtime event ordering or reducer behavior.
- Do not productize MCP, skills, subagent/multi-agent, or ACP.
- Do not merge into `main`.

## Non-Goals

- Do not introduce a runtime schema validator.
- Do not redesign terminal turn events.
- Do not remove compatibility `turn.completed.assistant_message` behavior.

## Acceptance Criteria

- Python contract tests prove `turn.completed` required fields match the
  gateway payload shape.
- Python contract tests prove `turn.status` exposes the expected state enum and
  required terminal routing fields.
- Node `test/client.test.ts` manifest parity passes.
- Relevant ruff, mypy, focused pytest, and Node typecheck pass.
- Trellis task is archived and committed on the feature branch.
