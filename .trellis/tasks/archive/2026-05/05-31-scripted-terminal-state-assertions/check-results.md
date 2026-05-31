# Check Results

## Verification

- `npm --prefix tui/node test -- --runInBand --test-name-pattern "scripted client submits a turn"`
  - Red before implementation: failed because `turn.submit_expect` was not
    recognized, so no `turn.submit` was sent.
  - Green after implementation: passed.
- `uv run pytest tests/integration/test_node_tui_gateway.py::test_run_node_tui_gateway_scripted_expected_failed_state tests/integration/test_node_tui_gateway.py::test_run_node_tui_gateway_scripted_expected_waiting_states -q`
  - Passed: `2 passed`.
- `uv run pytest -q`
  - Passed: `1200 passed`.
- `npm --prefix tui/node test -- --runInBand`
  - Passed: `137 passed`.
- `npm --prefix tui/node run typecheck`
  - Passed.
- `uv run ruff check tests/integration/test_node_tui_gateway.py`
  - Passed.

## Notes

- This slice adds a test-only scripted smoke action, not a product-facing RPC.
- Existing full-repo `ruff check .` remains affected by unrelated pre-existing
  `.claude`/`.trellis` lint violations documented in the previous slice.
