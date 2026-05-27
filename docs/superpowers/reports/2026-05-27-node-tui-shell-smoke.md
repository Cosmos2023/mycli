# Node TUI Shell Smoke

## Scope

- Interactive `mycli` defaults to Node Ink TUI.
- Python remains authoritative for runtime, sessions, tools, commands, approvals, and model-visible state.
- Node owns UI state, rendering, input, completion, overlays, and folded transcript state.
- RPC stdout/stdin stay separate from TTY UI rendering.

## Verification

| Command | Result |
| --- | --- |
| `uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py -q` | PASS, 91 tests |
| `npm --prefix tui/node test` | PASS, 22 tests |
| `npm --prefix tui/node run typecheck` | PASS |
| `uv run ruff check src tests` | PASS |
| `uv run mypy src/mycli` | PASS |
| `uv run pytest -q` | PASS, 961 tests |
| `HOME="$(mktemp -d)" MYCLI_NODE_TUI_SCRIPT='[...]' uv run mycli --node-tui --session node-tui-shell-scripted-smoke-20260527212942` | PASS |
| `uv run mycli --session node-tui-shell-manual-smoke` | PASS |

## Scripted Smoke Notes

- Real `mycli --node-tui` launched the scripted Node client and exited 0.
- stderr contained `runtime.ready`, many `turn.event` entries, and `turn.completed`.
- `/view verbose`, `/usage`, `/sessions`, and `/quit` all flowed through `command.run`.
- `/usage` reported `input_tokens=3983 max_tokens=100000`.
- `/sessions` showed the scripted session as active with `messages=4 summaries=1`.

## Manual Smoke Notes

- Default interactive `uv run mycli` opened the Node Ink shell without `--node-tui`.
- User message rendered immediately.
- Real provider turn used `Read`; the tool appeared as a folded one-line summary.
- Final answer streamed and reconciled into one assistant answer.
- `/view verbose` rendered a transcript command row.
- `/usage` and `/sessions` rendered overlays.
- `/quit` shut down cleanly with exit code 0.

## Fixes From Smoke

- PTY Enter input did not submit when the terminal delivered raw `\n`; `InputBox` now treats raw `\r`/`\n` as submit as well as Ink `key.return`.
- The old Textual-default routing test now explicitly covers `MYCLI_TUI_BACKEND=textual`, since Node TUI is the default interactive route.
