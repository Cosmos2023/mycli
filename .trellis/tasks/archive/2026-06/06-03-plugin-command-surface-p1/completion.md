# Plugin Command Surface P1 Completion

## Summary

- Added `provides_commands` support to `plugin.yaml`.
- Added `PluginCommandRegistry`, `PluginCommandSpec`, and structured
  `PluginCommandResult`.
- Added `PluginContext.register_command()`.
- Loaded enabled plugin commands into runtime-owned command registry.
- Added provider-free `mycli plugins run <plugin_id> <command_name>
  [--json-args JSON] [--json]`.
- Added `/plugin <plugin_id> <command_name> [json-args]` for in-session slash
  command execution through the existing command handler.
- Extended `plugins list|inspect` JSON and human output with commands.
- Extended doctor plugin diagnostics with command counts and registration
  issues.
- Updated plugin runtime contract spec and provider-free smoke.
- Hardened Node TUI doctor output to avoid absolute worktree path leakage in
  diagnostics.

## Verification

- `uv run pytest tests/unit/services/test_plugin_runtime.py tests/unit/cli/test_plugins_cli.py tests/unit/cli/test_main.py::test_build_command_handler_exposes_runtime_inspection_commands -q`
- `uv run pytest tests/unit/services/test_doctor_service.py::test_doctor_service_warns_for_problem_tool_execution_diagnostics_without_raw_payload -q`
- `uv run pytest tests/unit/services/test_doctor_service.py::test_doctor_service_reports_node_tui_dependency_status tests/unit/services/test_doctor_service.py::test_doctor_service_warns_when_node_tui_dependencies_are_missing_without_creating_them tests/unit/services/test_doctor_service.py::test_doctor_service_warns_when_node_tui_dependencies_are_incomplete -q`
- `uv run mypy src/mycli`
- `uv run ruff check src tests evaluation/plugin_runtime_smoke.py evaluation/hook_management_smoke.py`
- `uv run pytest tests/unit tests/integration -q`
- `uv run python evaluation/plugin_runtime_smoke.py`
- `uv run python evaluation/hook_management_smoke.py`

## Remaining Hermes Gaps

- No marketplace install/update/remove.
- No remote or entry-point plugin discovery.
- No rich command argument completion or interactive UI.
- No plugin-owned provider/gateway/LLM facade.
- No MCP/ACP/subagent plugin productization.

## Next Recommendation

The next slice should either add richer plugin command discovery/completion for
TUI clients or move to MCP plugin-facing registration once command and tool
surfaces are stable.
