# Hook Allowlist And Session Lifecycle Completion

## Branch

- `feature/mycli-hook-config-execution`

## Scope Completed

- Added user hook allowlist support at `<home>/.mycli/hook-allowlist.json`.
- Configured hooks are high-risk by default and are not executed unless their
  source, hook id, hook point, and command digest match the allowlist.
- Non-allowlisted, timed-out, failed, or invalid configured hooks now map to
  `HookAction.ERROR`; parent tool/session execution continues.
- Runtime fires `session_start` after configured hooks are registered and
  `session_end` through idempotent `AgentRuntime.close()` /
  `TurnService.close()`.
- CLI closes runtime once from the outer lifecycle boundary, including Node TUI
  fallback paths.
- `/hooks` runtime inspection and doctor report configured-hook allowlist
  status and malformed allowlist issues.
- Tool execution now applies post-tool hook `deny` and limited `modify`
  results before transcript, plan effects, lifecycle finish, and trace rows.
- Provider-free hook smoke covers blocked configured hooks, allowlisted
  execution, `/hooks`, doctor, `hook_execution` trace, and session lifecycle.

## Verification

- `uv run ruff check src tests evaluation/hook_smoke.py`
- `uv run mypy src/mycli`
- `uv run pytest tests/unit/services/test_configured_hooks.py tests/unit/services/test_hooks.py tests/unit/services/test_doctor_service.py tests/unit/application/test_tool_execution_service.py tests/unit/application/test_agent_runtime.py -q`
- `uv run python evaluation/hook_smoke.py`
- `uv run pytest tests/unit tests/integration -q`

## Final Test Result

- Full Python unit/integration: `1286 passed`
- Hook smoke output:
  `evaluation/runs/hook-smoke-20260602T144104Z.json`

## Remaining Risks

- No interactive `mycli hooks approve/revoke` command yet; allowlist entries are
  written directly by tests/smoke or by users editing JSON.
- Configured hook allowlist is loaded at registration time, so long-lived
  runtimes do not pick up allowlist edits until restart.
- Post-tool hook `modify` is intentionally narrow: summary, error, and
  `raw_payload` additions only. It does not mutate files or arbitrary tool
  effects.
- This is still hook foundation, not Hermes-like plugin packaging,
  marketplace, or subagent/MCP/ACP hook orchestration.

## Next Step

- Add a small hook management CLI (`hooks approve`, `hooks revoke`,
  `hooks list --json`) before plugin productization.
