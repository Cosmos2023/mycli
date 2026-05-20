# P3 Sub-agent Capability Pack Smoke

## Commands

- `uv run pytest tests/unit/domain/test_subagents.py tests/unit/application/runtime/subagents tests/unit/tools/test_task_tool.py tests/unit/application/test_turn_service_subagents.py -q`
  - Result: `21 passed in 0.46s`
- `uv run ruff check src tests`
  - Result: `All checks passed!`
- `uv run mypy src/mycli`
  - Result: `Success: no issues found in 200 source files`
- `uv run pytest -q`
  - Result: `818 passed in 6.53s`
- `MYCLI_HOME="$(mktemp -d)" uv run mycli --help`
  - Result: CLI help rendered successfully.

## Evidence

- `Task` is registered in default tool inventory and runtime-bound in `AgentRuntime`.
- Child tool scope excludes `Task`, `AskUserQuestion`, and plan-mode tools through the layered resolver.
- Child loop covers tool-call -> tool-result -> next turn behavior.
- Child stop statuses are covered for `max_turns`, `max_tool_calls`, `max_no_progress`, and `approval_required`.
- Parent receives only the final XML sub-agent report through the `Task` tool result payload.
- `/subagents` shows recent child runs from `SubAgentService`.

## Known Gaps

- Async mailbox, backgrounding, coordinator/team, worktree/remote agents, and fork cache sharing remain outside P3.
