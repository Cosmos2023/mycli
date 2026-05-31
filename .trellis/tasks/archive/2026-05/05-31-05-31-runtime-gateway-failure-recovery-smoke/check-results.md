# Check Results

## Verification

- `uv run pytest tests/integration/test_node_tui_gateway.py::test_run_node_tui_gateway_with_real_node_scripted_client_failure_recovery_matrix -q`
  - Passed: `1 passed`
- `uv run pytest tests/integration/test_node_tui_gateway.py tests/unit/cli/node_tui/test_gateway.py -q`
  - Passed: `47 passed`
- `node --import tsx --test test/reducer.test.ts test/scripted-client.test.ts`
  - Passed: `34 passed`
- `node --import tsx --test test/reducer.test.ts`
  - Passed: `31 passed`
- `npm --prefix tui/node run typecheck`
  - Passed
- `npm --prefix tui/node test`
  - Passed: `132 passed`
- `uv run ruff check tests/integration/test_node_tui_gateway.py`
  - Passed
- `uv run mypy tests/integration/test_node_tui_gateway.py`
  - Passed

## Notes

- An attempted `uv run ruff check` over TypeScript paths was invalid because
  Ruff parses Python only. TypeScript coverage is provided by Node typecheck
  and Node tests above.
