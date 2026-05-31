# Check Results

Checked at: 2026-05-31 20:00:04 CST

## Commands

- `uv run ruff check src/mycli/domain/runtime/gateway_contract.py tests/unit/domain/runtime/test_gateway_contract.py`
  - Result: passed
- `uv run mypy src/mycli/domain/runtime/gateway_contract.py tests/unit/domain/runtime/test_gateway_contract.py`
  - Result: passed
- `uv run pytest tests/unit/domain/runtime/test_gateway_contract.py tests/unit/services/test_extension_manifest.py -q`
  - Result: passed, 10 tests
- `node --import tsx --test test/client.test.ts`
  - Result: passed, 7 tests
- `npm run typecheck`
  - Working directory: `tui/node`
  - Result: passed
- `uv run pytest tests/unit/cli/node_tui/test_gateway.py -q`
  - Result: passed, 40 tests
- `node --import tsx --test test/reducer.test.ts`
  - Result: passed, 32 tests

## Notes

- `turn.completed` schema now advertises the stable fields emitted by
  `_turn_completed_payload()`.
- `turn.status` schema tests now lock the normalized terminal/waiting state
  taxonomy used by TUI reducers and future clients.
