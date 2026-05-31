# PRD: Node TUI Interrupted Scripted Smoke

## Summary

Add a concrete Node TUI gateway smoke test for interrupted turns. The scripted client must be able to exercise the real JSON-RPC flow instead of relying only on Python gateway unit tests or TypeScript reducer unit tests.

## Requirements

1. The Node scripted client supports a structured script action that submits a turn and requests interruption while the turn is running.
2. The action waits for the gateway to accept the turn, observes that the turn has started, sends `turn.interrupt`, and then waits for terminal interrupted status.
3. A Python integration test launches the real Node scripted client through `NodeTuiProcess` and `run_node_tui_gateway`.
4. The test uses a deterministic fake service that blocks during `handle_user_turn()` until the interrupt request has had a chance to propagate.
5. The dumped Node reducer state proves the TUI consumed the interrupted terminal state:
   - `turnRunning` is false
   - `currentTurnId` is null
   - `liveStatus.state` is `interrupted`
   - `pendingApproval` and `pendingClarification` are null
6. The change must not introduce new runtime dependencies or productize out-of-scope systems such as MCP, skills, subagents, or ACP.

## Non-goals

- Do not implement true cooperative cancellation of provider/tool execution in this slice.
- Do not change the external runtime event contract beyond adding scripted smoke support.
- Do not merge to `main`.

## Acceptance

- `uv run pytest tests/integration/test_node_tui_gateway.py tests/unit/cli/node_tui/test_gateway.py -q` passes.
- `npm --prefix tui/node test` passes.
- `npm --prefix tui/node run typecheck` passes.
- `uv run ruff check tests/integration/test_node_tui_gateway.py src/mycli/cli/node_tui/gateway.py` passes if Python files are changed.
- Trellis task is archived after implementation and verification.
