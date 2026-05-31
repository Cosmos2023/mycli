# Check Results

Checked at: 2026-05-31 17:00:10 CST

## Scope

- Runtime gateway error taxonomy contract for `gateway.error.code`.
- Cross-language alignment across Python runtime manifest, TypeScript protocol
  contracts, and Node reducer behavior.

## Verification

- `uv run pytest tests/unit/domain/runtime/test_gateway_contract.py tests/unit/services/test_extension_manifest.py tests/unit/cli/node_tui/test_gateway.py -q`
  - Result: passed, 41 tests.
- `uv run ruff check src/mycli/domain/runtime/gateway_contract.py tests/unit/domain/runtime/test_gateway_contract.py tests/unit/services/test_extension_manifest.py`
  - Result: passed.
- `npm --prefix tui/node test -- protocol`
  - Result: passed, full Node suite ran with 129 tests.
- `npm --prefix tui/node test -- reducer`
  - Result: passed, full Node suite ran with 129 tests.
- `npm --prefix tui/node run typecheck`
  - Result: passed, including `verify:deps` and `tsc --noEmit`.

## Acceptance Criteria

- Python unit test proves the canonical `gateway.error.code` enum is exposed in
  the runtime contract schema.
- Extension manifest test proves the enum is published for external clients.
- Existing Node protocol contract test proves TypeScript payload contracts stay
  aligned with the Python manifest schema.
- Node reducer test proves typed gateway errors preserve stable request error
  codes and method metadata in transcript diagnostics.
- Runtime TUI gateway spec documents the stable error taxonomy.

## Remaining Risk

- This slice intentionally covers gateway request errors only. Provider,
  runtime, and tool error taxonomy remain separate future hardening work.
- No new visual TUI panel was added for gateway errors; existing bounded
  transcript diagnostics remain the UI surface.
