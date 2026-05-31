# Gateway Error Emission Consistency

## Problem

`gateway.error` is now a stable runtime/TUI event contract, but not every
gateway request failure emits it. Some paths return JSON-RPC errors only, and
one malformed-message path emits an error code outside the declared taxonomy.

Hermes-agent is the maturity reference only. Do not copy Hermes code.

## Scope

Baseline branch: `feature/mycli-foundation-hardening-audit`

Default integration policy: do not merge to `main`.

This slice covers Runtime event contract parity, Diagnostics/trace foundation,
and Node TUI gateway foundation by making gateway request errors consistently
observable as events.

## Requirements

- Add a gateway-local helper for request-scoped failures that:
  - returns the existing JSON-RPC error response shape;
  - emits a matching `gateway.error` event when an event sink exists;
  - includes `method` for request-scoped errors;
  - keeps optional detail bounded and out of the JSON-RPC error response.
- Use only declared `GATEWAY_ERROR_CODES`.
- Replace the malformed inbound request code `invalid_request` with declared
  `invalid_params`.
- Unknown methods must return `method_not_found` and emit `gateway.error`.
- `_GatewayError` and `ValueError` request-handler failures must emit
  `gateway.error` as well as return JSON-RPC errors.
- Approval response validation failures must emit `gateway.error`:
  - unsupported choice -> `invalid_params`
  - no pending decision -> `decision_not_pending`
  - mismatched decision id -> `decision_not_pending`
  - turn already running -> `turn_in_progress`
- Keep `decision.resolve` compatibility behavior.
- Update the runtime/TUI gateway spec with the rule that request-scoped gateway
  errors are both response errors and event diagnostics.

## Acceptance Criteria

- Gateway unit tests prove unknown method, invalid params, approval no-pending,
  stale decision id, and turn-in-progress paths emit matching `gateway.error`
  events and keep their existing JSON-RPC error responses.
- Gateway unit tests prove malformed inbound request emission uses a declared
  error code.
- Existing unexpected exception behavior still emits `gateway.error` with
  bounded detail and returns `internal_error`.
- Focused checks pass:
  - `uv run pytest tests/unit/cli/node_tui/test_gateway.py tests/unit/domain/runtime/test_gateway_contract.py -q`
  - `uv run ruff check src/mycli/cli/node_tui/gateway.py tests/unit/cli/node_tui/test_gateway.py`
  - `npm --prefix tui/node test -- reducer`
  - `npm --prefix tui/node run typecheck`
- Trellis research, PRD, implementation context, check context, and check
  results are present.
- Task is archived after verification.

## Non-goals

- No new visual TUI error panel.
- No JSON-RPC protocol shape changes.
- No provider/tool runtime error taxonomy changes.
- No MCP, skills, subagent/multi-agent, or ACP productization.
- No merge to `main`.
