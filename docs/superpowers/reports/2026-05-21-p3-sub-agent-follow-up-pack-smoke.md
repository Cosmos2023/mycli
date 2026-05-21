# P3 Sub-agent Follow-up Pack Smoke

## Commands

- `uv run ruff check src tests`
  - Result: `All checks passed!`
- `uv run mypy src/mycli`
  - Result: `Success: no issues found in 201 source files`
- `uv run pytest -q`
  - Result: `838 passed in 7.92s`
- Real API background Task smoke with project `.mycli/config.toml`
  - Command shape: pipe a Chinese prompt into `uv run mycli --session p3-followup-background-smoke-2`, ask the parent agent to call `Task` with `mode="background"` and `agent_type="explore"`, then run `/subagents` and `/quit`.
  - Result: parent called `Task`; `/subagents` showed `explore running tools=0 p3-followup-background-smoke-2:sub:turn_450ac306a952432495c6dbff7426b0d6:72ea9378`.
- Real API child transcript inspection
  - Command shape: pipe `/subagents p3-followup-background-smoke-2:sub:turn_450ac306a952432495c6dbff7426b0d6:72ea9378` into the same session.
  - Result: transcript rendered system/user/tool_call/tool_result/final lines. The child used `LS`, `Read pyproject.toml`, and `Read README.md`, then reported project name `mycli` and main language Python.

## Evidence

- Child transcript sidechain persists under child session id.
- `/subagents` lists recent sync/background child runs.
- `/subagents <child_session_id>` renders child transcript summary without replaying it into parent context.
- Background Task enforces the configured concurrency cap.
- Child model requests use the shared model request lock.
- Sidechain writes use the transcript write lock.
- Background worker exceptions become failed summaries.
- Shutdown marks unfinished background children failed.
- `Task(mode="background")` returns `running` immediately and later updates run summary or sidechain state.
- Sync Task behavior remains compatible.

## Known Gaps

- No fork cache sharing.
- No async mailbox or SendMessage.
- No automatic 2-minute backgrounding.
- No cross-process background recovery.
- No coordinator/team or worktree/remote agents.
