# Subagent Runtime P0 Check Results

## Verification

- Consolidated MCP P0 baseline:
  - `uv run ruff check src tests evaluation/mcp_smoke.py` passed
  - `uv run mypy src/mycli` passed
  - `uv run pytest tests/unit tests/integration -q` passed: 1323 passed
  - `uv run python evaluation/mcp_smoke.py` passed
  - `uv run python evaluation/plugin_runtime_smoke.py` passed
  - `uv run python evaluation/hook_management_smoke.py` passed
- Subagent focused tests:
  - `uv run pytest tests/unit/services/test_subagent_registry.py tests/unit/application/runtime/subagents/test_sub_agent_service.py tests/unit/application/runtime/subagents/test_profiles.py tests/unit/application/test_subagent_tool_lifecycle.py tests/unit/tools/test_task_tool.py tests/unit/cli/test_main.py tests/unit/services/test_doctor_service.py tests/unit/services/test_extension_manifest.py -q`
  - Result: 184 passed
- `uv run python evaluation/subagent_smoke.py`
  - Result: passed
- `uv run ruff check src tests evaluation/subagent_smoke.py evaluation/mcp_smoke.py`
  - Result: passed
- `uv run mypy src/mycli`
  - Result: passed
- `uv run python evaluation/mcp_smoke.py`
  - Result: passed
- `uv run python evaluation/plugin_runtime_smoke.py`
  - Result: ok=true
- `uv run python evaluation/hook_management_smoke.py`
  - Result: ok=true
- `uv run pytest tests/unit tests/integration -q`
  - Result: 1332 passed

## Notes

- Subagent profiles now load from built-in, user, and repo sources.
- `mycli subagents list|inspect` is provider-free.
- `DoctorService` reports configured profile diagnostics and high-risk tool exposure warnings.
- Runtime `SubAgentService` now uses an injected profile lookup so configured profiles can be invoked by `Task` or `subagent.<profile>` tools.
