# Check Results

## Verification

- `uv run pytest tests/unit/cli/node_tui/test_gateway.py::test_gateway_turn_submit_emits_approval_request_when_waiting tests/unit/cli/node_tui/test_gateway.py::test_gateway_approval_respond_accepts_stable_decision_id tests/unit/cli/node_tui/test_gateway.py::test_gateway_approval_respond_rejects_stale_decision_id tests/unit/cli/node_tui/test_gateway.py::test_gateway_approval_respond_maps_choice_and_keeps_decision_resolve_compatible -q`
  - Result: passed, 4 tests.
- `uv run pytest tests/unit/cli/node_tui/test_gateway.py tests/integration/test_node_tui_gateway.py -q`
  - Result: passed, 39 tests.
- `node --test tui/node/test/reducer.test.ts tui/node/test/client.test.ts`
  - Result: passed, 30 tests.
- `uv run ruff check src/mycli/cli/node_tui/gateway.py tests/unit/cli/node_tui/test_gateway.py tests/integration/test_node_tui_gateway.py`
  - Result: passed.
- `npm --prefix tui/node run typecheck`
  - Result: passed.

## Notes

- `approval.request.decision_id` now uses the pending tool call id when
  available.
- `approval.respond` accepts either the stable active decision id or the
  compatibility alias `decision_current`.
- Stale ids return `decision_not_pending` before resolving the pending
  decision.
