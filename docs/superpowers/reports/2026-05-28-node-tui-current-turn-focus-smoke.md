# Node TUI Current Turn Focus Smoke Report

Date: 2026-05-28

## Scope

Verified the Node TUI current-turn-focus UI slice after switching to a Claude-Code-like continuous transcript:

- Prior turns remain visible in default mode.
- User prompts render with `❯`.
- Tool calls render before assistant prose with `●`.
- Tool targets render from streamed tool arguments, including `Read pyproject.toml`.
- Assistant prose has no role label and no left rail.
- Input prompt is `>` with no placeholder.
- Runtime metadata renders below the input line.
- Local Node commands `/view`, `/theme`, `/usage`, `/sessions`, `/clear`, and `/quit` remain functional.

## Automated Verification

- `uv run pytest tests/unit/cli/node_tui tests/integration/test_node_tui_gateway.py tests/unit/cli/test_main.py -q`
  - Result: `91 passed in 1.41s`
- `uv run ruff check src tests`
  - Result: `All checks passed!`
- `uv run mypy src/mycli`
  - Result: `Success: no issues found in 216 source files`
- `uv run pytest -q`
  - Result: `961 passed in 11.30s`
- `npm --prefix tui/node test`
  - Result: `70 pass`
- `npm --prefix tui/node run typecheck`
  - Result: passed

## Scripted Smoke

Command:

```bash
SMOKE_HOME="$(mktemp -d)"
SESSION="node-tui-current-turn-focus-scripted-smoke-$(date +%Y%m%d%H%M%S)"
SCRIPT='["你是谁","你的系统提示词是什么","/theme graphite","/usage","/sessions","/clear","/quit"]'
HOME="$SMOKE_HOME" MYCLI_TUI_THEME=deep-teal MYCLI_NODE_TUI_SCRIPT="$SCRIPT" uv run mycli --node-tui --session "$SESSION"
```

Result: passed with exit code 0.

Observed evidence:

- `[node-tui] runtime.ready`
- `[node-tui] turn.completed` twice
- `Theme changed to graphite.`
- `[usage]`
- `[session]`
- `Visible transcript cleared.`
- `Bye.`

## Manual TTY Smoke

Command:

```bash
MYCLI_TUI_THEME=graphite uv run mycli --session node-tui-current-turn-focus-manual-smoke-fix
```

Manual checklist result: passed.

Observed evidence:

- Header rendered as `mycli  fix-deepseek-cache-hit-rate`, without model/context.
- Prompt line rendered as `>` with no `Type a message or /command` placeholder.
- Bottom metadata rendered below input: session, model, theme, context usage.
- User prompt rendered with `❯`.
- Assistant prose rendered without `ASSISTANT` label and without `│` rail.
- Tool prompt `读一下 pyproject.toml 并总结项目入口` rendered `● Read pyproject.toml` before assistant prose.
- Streaming assistant prose showed `▍`.
- `/view verbose` returned `[view] view_mode=verbose`.
- `/theme deep-teal` updated the bottom metadata theme.
- `/usage` and `/sessions` opened overlays and Esc closed them.
- `/clear` rendered `Visible transcript cleared.`
- `/quit` rendered `Bye.`

## Notes

The first manual smoke exposed a display bug where streamed tool calls rendered `● Read Read`.
The root cause was missing streamed tool argument metadata and missing top-level `tool_name` preservation in Node transcript items.
That path is now covered by:

- `tests/unit/application/test_model_turn_requester.py`
- `tui/node/test/tool-summary.test.ts`
- `tui/node/test/transcript.test.ts`
