# Runtime Gateway Error Taxonomy Contract

## Problem

`gateway.error` is part of the Hermes-like runtime/TUI contract, but its
machine-readable `code` field is still an unconstrained string. TUI, extension,
and future ACP clients need a stable error taxonomy so request failures can be
handled without parsing text.

Hermes-agent is the maturity reference only. Do not copy Hermes code.

## Scope

Baseline branch: `feature/mycli-foundation-hardening-audit`

Default integration policy: do not merge to `main`.

This slice covers Runtime event contract parity and Node TUI gateway foundation
by making `gateway.error.code` a cross-language contract.

## Requirements

- Define canonical gateway error codes in Python domain contract:
  - `internal_error`
  - `invalid_params`
  - `method_not_found`
  - `turn_in_progress`
  - `decision_not_pending`
  - `clarification_not_pending`
- `gateway.error` payload schema must enumerate those codes.
- TypeScript protocol types must expose the same `GatewayErrorCode` union.
- TypeScript `GATEWAY_EVENT_PAYLOAD_CONTRACTS["gateway.error"]` must enumerate
  the same codes so existing Python-vs-TS contract tests catch drift.
- Reducer/client behavior remains compatible: errors still append bounded error
  transcript rows.
- Update the runtime/TUI gateway spec with the code taxonomy.

## Acceptance Criteria

- Python unit test proves `gateway.error` schema includes the canonical enum.
- Existing Node protocol contract test proves TS enum matches Python manifest.
- Node reducer test proves a typed `gateway.error` still appends one error row
  with code/method metadata.
- Focused checks pass:
  - `uv run pytest tests/unit/domain/runtime/test_gateway_contract.py tests/unit/cli/node_tui/test_gateway.py -q`
  - `npm --prefix tui/node test -- protocol`
  - `npm --prefix tui/node test -- reducer`
  - `npm --prefix tui/node run typecheck`
  - `uv run ruff check src/mycli/domain/runtime/gateway_contract.py tests/unit/domain/runtime/test_gateway_contract.py`
- Trellis research, PRD, implementation context, check context, and check
  results are present.
- Task is archived after verification.

## Non-goals

- No new UI panel for errors.
- No JSON-RPC transport migration.
- No provider/tool runtime error taxonomy beyond gateway request errors.
- No MCP, skills, subagent/multi-agent, or ACP productization.
- No merge to `main`.
