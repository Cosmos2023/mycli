# Check Results

## Verification

- `uv run pytest tests/unit/cli/node_tui/test_gateway.py::test_gateway_turn_interrupt_suppresses_late_normal_completion -q`
  - Red before implementation: failed because `turn.completed`,
    final `message.complete`, and completed status were still emitted after
    interrupt.
  - Green after implementation: passed.
- `npm --prefix tui/node test -- --runInBand --test-name-pattern "interrupted turn ignores stale completion"`
  - Red before implementation: failed because reducer changed live status from
    `interrupted` to `completed`.
  - Green after implementation: passed.
- `uv run pytest tests/integration/test_node_tui_gateway.py::test_run_node_tui_gateway_with_real_node_scripted_client_interrupted_turn tests/integration/test_node_tui_gateway.py::test_run_node_tui_gateway_with_real_node_scripted_client_suppresses_late_completion -q`
  - Passed: `2 passed`.
- `uv run pytest tests/unit/cli/node_tui/test_gateway.py::test_gateway_turn_interrupt_reports_running_state tests/unit/cli/node_tui/test_gateway.py::test_gateway_turn_interrupt_suppresses_late_normal_completion tests/integration/test_node_tui_gateway.py::test_run_node_tui_gateway_with_real_node_scripted_client_interrupted_turn tests/integration/test_node_tui_gateway.py::test_run_node_tui_gateway_with_real_node_scripted_client_suppresses_late_completion -q`
  - Passed: `4 passed`.
- `uv run pytest -q`
  - Passed: `1198 passed`.
- `npm --prefix tui/node test -- --runInBand`
  - Passed: `136 passed`.
- `npm --prefix tui/node run typecheck`
  - Passed.
- `uv run ruff check src/mycli/cli/node_tui/gateway.py src/mycli/domain/runtime/gateway_contract.py tests/unit/cli/node_tui/test_gateway.py tests/integration/test_node_tui_gateway.py`
  - Passed.
- `uv run mypy src/mycli/cli/node_tui/gateway.py src/mycli/domain/runtime/gateway_contract.py`
  - Passed.

## Known Existing Verification Gap

- `uv run ruff check .` is blocked by pre-existing `.claude` and `.trellis`
  script lint violations unrelated to this slice. The changed Python files were
  linted directly and passed.
