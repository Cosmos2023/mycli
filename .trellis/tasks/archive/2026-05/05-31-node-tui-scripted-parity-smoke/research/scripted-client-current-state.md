# Scripted Client Current State

## Files Inspected

- `tests/integration/test_node_tui_gateway.py`
- `tui/node/src/smoke/scriptedClient.ts`
- `tui/node/src/state/localCommands.ts`
- `tui/node/src/state/reducer.ts`
- `.trellis/spec/backend/runtime-tui-gateway-contract.md`

## Findings

- The existing Python integration already launches the real Node entrypoint
  with `MYCLI_NODE_TUI_SCRIPT` and `MYCLI_NODE_TUI_STATE_DUMP`.
- The scripted client handles local slash commands before calling
  `GatewayClient.send("command.run", ...)`.
- `/help` is a local command that returns a `command.result` with
  `presentation: "overlay"`; it should not append a transcript row.
- `/theme mono` is local and appends a `command_output` transcript item while
  updating `themeName`.
- The existing typed-stream integration sends reasoning, two text deltas, and
  completion metadata, then reconciles the final assistant message from
  `turn.completed`.

## Test Shape

Extend the existing real Node scripted-client integration instead of adding a
new transport harness. The most direct smoke script is:

```json
["/help", "/theme mono", "hello"]
```

Useful final-state assertions:

- `service.messages == ["hello"]`
- `state.overlay.visible == true`
- `state.overlay.title == "/help"`
- `state.overlay.lines` includes `Enter send message` and
  `Approval: press 1-9`
- `state.themeName == "mono"`
- Transcript includes `Theme changed to mono.`
- Assistant visible items collapse to `["hello final"]`
- Assistant text does not contain `checking files` or `hellohello`
