# Check Results

## Commands

- `uv run pytest tests/integration/test_node_tui_gateway.py -q`
- `uv run ruff check tests/integration/test_node_tui_gateway.py`

## Result

- 6 integration tests passed.
- Ruff passed.

## Acceptance Evidence

- Real Node scripted client sends `approval.respond(choice=reject)` through the
  gateway.
- Fake service receives mapped runtime choice `"2"`.
- Dumped Node state clears `pendingApproval` and `pendingClarification`.
- Dumped Node state reports `liveStatus.state === "rejected"` with the bounded
  rejection message.
- No assistant stream/final item is appended for the rejected approval turn.
