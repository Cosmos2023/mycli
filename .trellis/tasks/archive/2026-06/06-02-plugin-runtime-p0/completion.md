# Plugin Runtime P0 Completion

## Summary

- Added repo/user plugin discovery for directory plugins with `plugin.yaml` and
  `__init__.py`.
- Added opt-in enablement via existing TOML config `[plugins] enabled/disabled`.
- Added minimal `PluginContext` with `register_hook()` and `register_tool()`.
- Loaded enabled plugins into runtime `HookManager` and `ToolRegistry`.
- Added plugin tool manifest metadata with `source=plugin` and stable
  `plugin:<plugin_id>:<tool_name>` ids.
- Added provider-free `mycli plugins list|inspect [--json]`.
- Added `doctor` plugin diagnostics.
- Added provider-free plugin runtime smoke and unit/runtime coverage.
- Added backend plugin runtime contract spec.

## Verification

- `uv run ruff check src tests evaluation/plugin_runtime_smoke.py evaluation/hook_management_smoke.py`
- `uv run mypy src/mycli`
- `uv run pytest tests/unit/services/test_plugin_runtime.py tests/unit/cli/test_plugins_cli.py -q`
- `uv run pytest tests/unit/application/test_agent_runtime.py::test_agent_runtime_loads_enabled_plugin_hooks_and_tools -q`
- `uv run pytest tests/unit tests/integration -q`
- `uv run python evaluation/plugin_runtime_smoke.py`
- `uv run python evaluation/hook_management_smoke.py`

## Remaining Hermes Gaps

- No marketplace install/update/remove.
- No pip entry point discovery.
- No plugin CLI/slash command registration.
- No provider plugin surfaces for model, memory, web, image, video, browser, or
  gateway platforms.
- No plugin LLM facade.
- No MCP/ACP/subagent productization in this slice.

## Next Recommendation

The next Hermes-aligned slice should add plugin command surfaces:

1. `PluginContext.register_command()` for in-session slash commands.
2. Optional `PluginContext.register_cli_command()` for provider-free CLI
   subcommands.
3. Plugin command diagnostics in `mycli plugins inspect`.
4. Smoke coverage with a demo plugin command.
