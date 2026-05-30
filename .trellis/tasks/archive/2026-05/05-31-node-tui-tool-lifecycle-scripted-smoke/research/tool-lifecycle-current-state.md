# Tool Lifecycle Current State

## Files Inspected

- `src/mycli/cli/node_tui/gateway.py`
- `tests/unit/cli/node_tui/test_gateway.py`
- `tui/node/src/state/reducer.ts`
- `tui/node/src/state/transcript.ts`
- `tui/node/src/state/toolSummary.ts`
- `tui/node/test/reducer.test.ts`
- `tui/node/test/transcript.test.ts`
- `tests/integration/test_node_tui_gateway.py`
- `.trellis/spec/backend/runtime-tui-gateway-contract.md`

## Findings

- Python gateway converts runtime stream kinds:
  - `tool_start` -> `tool.start`
  - `tool_progress` -> `tool.progress`
  - `tool_complete` -> `tool.complete`
  - `tool_failed` -> `tool.failed`
- Gateway unit tests already verify those notifications and payloads.
- Node reducer routes all four lifecycle methods through
  `applyToolLifecycleEvent(...)`.
- Node transcript logic matches rows by `tool_id` first and `call_id` second,
  so completion/progress update one row instead of appending duplicates.
- Current real Node scripted-client integration covers typed text/reasoning and
  waiting-state response routes, but not tool lifecycle rows.

## Test Shape

Use the existing string script path:

```json
["tool lifecycle"]
```

The fake integration service can emit:

- `tool_start`, `tool_progress`, `tool_complete` for `call_read_1`.
- `tool_start`, `tool_failed` for `call_write_1`.
- `RuntimeStreamEvent(kind="text_delta", text="tools done")` and final
  `TurnResponse(assistant_message="tools done final")`.

The final reducer state should contain two `tool_summary` rows:

- `call_read_1` with `status="done"`, `stage="executing"`, `duration_s`, and
  summary.
- `call_write_1` with `status="failed"` and error metadata.

Assistant visible rows should collapse to one final answer.
