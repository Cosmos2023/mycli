# Check Results

## Verification

- `uv run pytest tests/integration/test_turn_service.py::test_resolve_pending_decision_reject_clears_it tests/unit/cli/node_tui/test_gateway.py::test_gateway_approval_reject_emits_rejected_terminal_status -q`
  - Result: passed, 2 tests.
- `node --test tui/node/test/reducer.test.ts`
  - Result: passed, 26 tests.
- `uv run pytest tests/integration/test_turn_service.py tests/unit/cli/node_tui/test_gateway.py tests/unit/domain/test_runtime.py -q`
  - Result: passed, 67 tests.
- `npm --prefix tui/node test`
  - Result: passed, 124 tests.
- `npm --prefix tui/node run typecheck`
  - Result: passed.
- `uv run ruff check src/mycli/domain/runtime/protocol.py src/mycli/application/runtime/turn_executor.py src/mycli/cli/node_tui/gateway.py tests/integration/test_turn_service.py tests/unit/cli/node_tui/test_gateway.py`
  - Result: passed.

## Notes

- Rejected approvals now persist as `TurnStatus.REJECTED` with
  `StopReason.APPROVAL_REJECTED`.
- Gateway emits `turn.status(state=rejected, terminal=true)` and
  `status.update(state=rejected)` with bounded rejection detail.
- Node protocol and reducer accept `rejected` as a terminal state and clear
  pending/live turn state.
