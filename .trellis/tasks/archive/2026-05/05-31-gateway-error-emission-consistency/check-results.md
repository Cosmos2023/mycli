# Check Results

Checked at: 2026-05-31 17:30:49 CST

## Scope

- Gateway request failure observability for `gateway.error`.
- Alignment between JSON-RPC error responses, gateway error events, declared
  error-code taxonomy, and Node reducer behavior.

## Verification

- `uv run pytest tests/unit/cli/node_tui/test_gateway.py tests/unit/domain/runtime/test_gateway_contract.py tests/integration/test_node_tui_gateway.py -q`
  - Result: passed, 49 tests.
- `uv run ruff check src/mycli/cli/node_tui/gateway.py src/mycli/domain/runtime/gateway_contract.py tests/unit/cli/node_tui/test_gateway.py tests/integration/test_node_tui_gateway.py`
  - Result: passed.
- `npm --prefix tui/node run typecheck`
  - Result: passed, including `verify:deps` and `tsc --noEmit`.
- `npm --prefix tui/node test -- reducer`
  - Result: passed, full Node suite ran with 130 tests.

## Acceptance Criteria

- Unknown method, incompatible protocol, invalid turn submit params, turn
  concurrency, unsupported approval choices, missing approval decision, stale
  approval decision id, and blank clarification responses now emit
  `gateway.error` when an event sink exists while preserving JSON-RPC error
  responses.
- Malformed inbound non-request messages now emit declared `invalid_params`
  instead of the undeclared `invalid_request` code.
- `incompatible_protocol` is part of the declared gateway error taxonomy in the
  Python runtime contract, extension manifest, and TypeScript protocol
  contract.
- Existing unexpected exception behavior still emits `gateway.error` with
  bounded detail and returns `internal_error`.
- Node reducer/scripted smoke coverage confirms gateway error events remain
  visible as one bounded error row.

## Remaining Risk

- This slice does not add persistence of gateway request errors to runtime
  traces; it only standardizes live gateway event emission.
- Full Python test suite and real interactive Node TUI smoke were not run for
  this narrow gateway contract slice.
