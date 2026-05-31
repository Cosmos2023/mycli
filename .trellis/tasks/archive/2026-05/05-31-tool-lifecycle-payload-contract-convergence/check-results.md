# Check Results

Checked at: 2026-05-31 20:08:52 CST

## Commands

- `uv run ruff check src/mycli/domain/runtime/gateway_contract.py tests/unit/domain/runtime/test_gateway_contract.py`
  - Result: passed
- `uv run mypy src/mycli/domain/runtime/gateway_contract.py tests/unit/domain/runtime/test_gateway_contract.py`
  - Result: passed
- `uv run pytest tests/unit/domain/runtime/test_gateway_contract.py tests/unit/services/test_extension_manifest.py -q`
  - Result: passed, 11 tests
- `node --import tsx --test test/client.test.ts test/reducer.test.ts`
  - Result: passed, 39 tests
- `npm run typecheck`
  - Working directory: `tui/node`
  - Result: passed
- `uv run pytest tests/unit/cli/node_tui/test_gateway.py -q`
  - Result: passed, 40 tests
- `uv run pytest -q`
  - Result: passed, 1175 tests

## Notes

- Tool lifecycle schemas now require `client_turn_id` for `tool.start`,
  `tool.progress`, `tool.complete`, and `tool.failed`.
- Runtime behavior was not changed; this slice only makes the existing
  gateway/TUI contract explicit and test-backed.
