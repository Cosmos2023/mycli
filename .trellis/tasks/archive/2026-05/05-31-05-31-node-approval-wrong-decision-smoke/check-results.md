# Check Results

## Commands

- `uv run pytest tests/integration/test_node_tui_gateway.py -q`
- `uv run ruff check tests/integration/test_node_tui_gateway.py`

## Result

- 7 integration tests passed.
- Ruff passed.

## Acceptance Evidence

- Real Node scripted smoke submits a turn that creates pending approval.
- `approval.respond_raw` with the wrong `decision_id` returns a visible
  request error in dumped TUI state.
- The fake service does not resolve the approval.
- Dumped TUI state keeps `pendingApproval.decision_id == "call_approval_1"`.
- The request error row carries `method=approval.respond`,
  `code=decision_not_pending`, the bounded gateway message, and
  `source=request`.
