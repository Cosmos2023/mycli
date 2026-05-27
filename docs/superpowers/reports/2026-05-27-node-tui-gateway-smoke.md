# Node TUI Gateway Smoke

## Scope

- Python remains the authoritative runtime.
- Node subprocess communicates with Python through line-delimited JSON-RPC.
- RPC stdout/stdin stay separate from human-readable Node output.
- `mycli --plain` remains unaffected.

## Verification

| Command | Result |
| --- | --- |
| `uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py::test_main_routes_node_tui_flag_to_gateway tests/unit/cli/test_main.py::test_main_routes_node_tui_env_backend tests/unit/cli/test_main.py::test_main_plain_overrides_node_tui_backend -q` | PASS: 24 passed |
| `npm --prefix tui/node test` | PASS: 5 passed |
| `uv run ruff check src tests` | PASS |
| `uv run mypy src/mycli` | PASS: no issues in 216 source files |
| `uv run pytest -q` | PASS: 952 passed |
| `HOME="$(mktemp -d)" MYCLI_NODE_TUI_SCRIPT='[...]' uv run mycli --node-tui --session node-tui-gateway-smoke-20260527162627` | PASS: exit code 0 |

## Real Smoke Evidence

- Observed `[node-tui] runtime.ready`, `[node-tui] turn.started`, many `[node-tui] turn.event` lines, and `[node-tui] turn.completed`.
- `/usage` returned through `command.run` with `turns=1` and provider context-window usage.
- `/session` returned `messages=4`, `pending_decision=no`, and `suspended_turn=no`.
- `/quit` returned `Bye.` and the Node client exited cleanly after closing its readline input.

## Notes

- The first Node client is a protocol smoke client, not the final Claude Code-like TUI.
- Human-readable Node output uses stderr; stdout remains reserved for RPC payloads.
- `turn.interrupt` is cooperative in this slice and does not hard-kill provider or tool calls.
