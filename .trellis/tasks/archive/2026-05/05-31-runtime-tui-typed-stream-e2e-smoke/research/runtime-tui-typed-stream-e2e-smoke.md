# Runtime TUI Typed Stream End-to-End Smoke Research

## Existing Entrypoints

- Python gateway:
  - `src/mycli/cli/node_tui/gateway.py`
  - `run_node_tui_gateway(service, process)` starts a process, sends
    notifications through JSON-RPC lines, reads Node requests, and delegates to
    `NodeTuiGateway`.
- Node process wrapper:
  - `src/mycli/cli/node_tui/process.py`
  - `NodeTuiProcess` wraps a subprocess with stdin/stdout pipes.
  - `build_node_command(...)` uses `node src/index.js` when
    `MYCLI_NODE_TUI_SCRIPT` is set.
- Node scripted client:
  - `tui/node/src/index.js` imports `smoke/scriptedClient.ts`.
  - `runScriptedClient(...)` sends `session.bootstrap`, then scripted commands
    or turns from `MYCLI_NODE_TUI_SCRIPT`.

## Current Gap

- `tui/node/test/scripted-client.test.ts` fakes gateway responses in-process.
- `tests/unit/cli/node_tui/test_gateway.py` tests Python gateway without a real
  Node process.
- No test currently runs both sides together over stdio.

## Recommended Smoke Shape

- Add a test under `tests/integration/test_node_tui_gateway.py`.
- Construct `NodeTuiProcess` with:
  - args: `["node", "<repo>/tui/node/src/index.js"]`
  - env: current env plus `MYCLI_NODE_TUI_SCRIPT=["hello"]`
  - cwd: repo root
- Use a fake service with `handle_user_turn(..., stream_sink=...)` that emits:
  - `RuntimeStreamEvent(kind="reasoning", text="checking files")`
  - `RuntimeStreamEvent(kind="text_delta", text="hel")`
  - `RuntimeStreamEvent(kind="text_delta", text="lo")`
  - `RuntimeStreamEvent(kind="completed", metadata={"response_status": "completed"})`
  - returns `TurnResponse(assistant_message="hello final")`
- Extend the scripted client with optional env `MYCLI_NODE_TUI_STATE_DUMP`.
  When set, it writes a bounded JSON state snapshot at shutdown.

## Why State Dump Is Acceptable

- It is test-only opt-in behavior controlled by env.
- It avoids scraping terminal frames or stderr logs.
- It proves the reducer consumed cross-process events correctly.
- It does not change the production TUI path when the env var is unset.

## Risks

- The new worktree may not have local Node dependencies installed. Use the
  project dependency setup or a local symlink only for verification; never
  commit `node_modules`.
- Keep dumped state bounded enough for tests. The full reducer state is small in
  the scripted smoke path.
- The smoke should not rely on real provider keys or user config.
