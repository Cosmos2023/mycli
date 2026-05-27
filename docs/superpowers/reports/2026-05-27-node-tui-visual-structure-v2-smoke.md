# Node TUI Visual Structure V2 Smoke

## Scope

- Header band.
- Compact display-only welcome surface.
- User prompt row.
- Assistant rail block with bounded final markdown.
- Tool timeline rows.
- Running activity line.
- Bottom command bar.
- Width-aware truncation and metadata elision.

## Verification

| Command | Result |
| --- | --- |
| `npm --prefix tui/node test` | PASS, 61 tests |
| `npm --prefix tui/node run typecheck` | PASS |
| `uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py -q` | PASS, 91 tests |
| `uv run ruff check src tests` | PASS |
| `uv run mypy src/mycli` | PASS, 216 source files |
| `uv run pytest -q` | PASS, 961 tests |
| `MYCLI_TUI_THEME=deep-teal MYCLI_NODE_TUI_SCRIPT='["你是谁","/theme graphite","/usage","/sessions","/clear","/quit"]' uv run mycli --node-tui --session <scripted-session>` | PASS |
| `MYCLI_TUI_THEME=deep-teal uv run mycli --session node-tui-visual-structure-v2-manual-smoke-2` | PASS |

## Scripted Smoke Notes

- Process exited with code 0.
- Output included `[node-tui] runtime.ready`.
- Output included `[node-tui] turn.completed`.
- Output included `Theme changed to graphite.`
- Output included `[usage]`.
- Output included `[session]`.
- Output included `Visible transcript cleared.`
- Output included `Bye.`
- Output did not include `Unknown command: /theme graphite`.

## Manual Notes

- Header band rendered brand, workspace, session, model, and context without broken wrapping.
- The startup welcome surface disappeared after conversation content appeared.
- User and assistant rows were visually distinct without role cards.
- User prompt used `›` without a `USER` label.
- Assistant text used a bounded column and left rail without an `ASSISTANT` label.
- `/theme graphite` changed visible accents while keeping transcript content intact.
- `/usage` and `/sessions` overlays remained functional and width-bounded.
- `/clear` cleared the visible transcript only.
- `/quit` exited cleanly.

## Follow-Up Fix From Smoke

Manual TTY smoke initially exposed awkward wrapping in an 80-column terminal because the app defaulted to width `100`. Commit `e6fecc5` changed the default Node TUI width to `80` and tightened welcome workspace truncation. Focused Node tests and typecheck passed after that fix, and the repeated manual TTY smoke rendered cleanly.
