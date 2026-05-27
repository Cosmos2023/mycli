# Node TUI Daily UI Polish Smoke

## Scope

- Branded Console theme system.
- Node-local `/theme` and `/clear`.
- Structured tool rows.
- Themed overlays, status, input, notices.
- Basic final-answer markdown rendering.

## Verification

| Command | Result |
| --- | --- |
| `npm --prefix tui/node test` | PASS, 45 tests |
| `npm --prefix tui/node run typecheck` | PASS |
| `uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py -q` | PASS, 91 tests |
| `uv run ruff check src tests` | PASS |
| `uv run mypy src/mycli` | PASS |
| `uv run pytest -q` | PASS, 961 tests |
| `MYCLI_TUI_THEME=graphite MYCLI_NODE_TUI_SCRIPT='["请使用 Read 工具读取 pyproject.toml，然后用一句话回答项目名和 CLI 入口点。","/theme mono","/usage","/sessions","/quit"]' uv run mycli --node-tui --session <scripted-session>` | PASS |
| `MYCLI_TUI_THEME=deep-teal uv run mycli --session node-tui-polish-manual-smoke` | PASS |

## Scripted Notes

- Scripted smoke emitted `[node-tui] runtime.ready`, `[node-tui] turn.event`, and `[node-tui] turn.completed`.
- `/theme mono` was handled locally and emitted `Theme changed to mono.`.
- `/theme mono` did not produce `Unknown command` after the scripted client local-command fix.
- `/usage`, `/sessions`, and `/quit` still ran through Python command handling.

## Manual Notes

- Default `deep-teal` theme rendered in the header and status line.
- `/theme graphite` changed visible Node UI state without a model turn.
- `/theme nope` showed a local warning and kept the current visible theme.
- `/usage` and `/sessions` rendered themed overlays.
- `/clear` cleared visible Node transcript only.
- `/quit` exited cleanly.
