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
- Real API smoke with project `.mycli/config.toml` DeepSeek provider:
  - Command shape: pipe a prompt into `uv run mycli --session p3-real-subagent-smoke-3`, ask the parent agent to use `Task` with an `explore` sub-agent, then run `/subagents` and `/quit`.
  - Result: parent model called `Task`; child sub-agent completed; parent summarized the child report; `/subagents` showed the completed child run.
- `uv run pytest tests/unit/application/runtime/subagents/test_child_loop.py tests/unit/services/test_safety_policy.py::test_safety_policy_auto_allows_task_delegation -q`
  - Result: `4 passed in 0.54s`

## Evidence

- `Task` is registered in default tool inventory and runtime-bound in `AgentRuntime`.
- `Task` is auto-allowed by the safety policy so model-initiated delegation can reach the runtime.
- Child tool scope excludes `Task`, `AskUserQuestion`, and plan-mode tools through the layered resolver.
- Child loop covers tool-call -> tool-result -> next turn behavior, including provider-required `tool_call_id` on tool result messages.
- Child stop statuses are covered for `max_turns`, `max_tool_calls`, `max_no_progress`, and `approval_required`.
- Parent receives only the final XML sub-agent report through the `Task` tool result payload.
- `/subagents` shows recent child runs from `SubAgentService`.

## Real API Findings

- First real run exposed that `Task` was registered but blocked as an unsupported tool by `SafetyPolicy`; regression coverage now keeps `Task` auto-allowed.
- Second real run exposed a provider contract issue: assistant tool calls must be followed by tool messages with matching `tool_call_id`; the child loop now preserves the call id.
- Successful real run reported project name `mycli`, main language Python, Python requirement `>= 3.13`, Hatchling build backend, and CLI entry point `mycli.cli.main:main`.

## Known Gaps

- Async mailbox, backgrounding, coordinator/team, worktree/remote agents, and fork cache sharing remain outside P3.
