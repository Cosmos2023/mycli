# MCP Tool Runtime P0 Check Results

## Verification

- `uv run pytest tests/unit/services/test_mcp_client.py tests/unit/services/test_mcp_diagnostics.py tests/unit/application/test_mcp_tool_lifecycle.py tests/unit/cli/test_main.py tests/unit/services/test_extension_manifest.py tests/unit/services/test_mcp_provider.py -q`
  - Result: 97 passed
- `uv run python evaluation/mcp_smoke.py`
  - Result: passed
- `uv run ruff check src tests evaluation/mcp_smoke.py`
  - Result: passed
- `uv run mypy src/mycli`
  - Result: passed
- `uv run pytest tests/unit tests/integration -q`
  - Result: 1322 passed
- `uv run python evaluation/plugin_runtime_smoke.py`
  - Result: ok=true
- `uv run python evaluation/hook_management_smoke.py`
  - Result: ok=true
- Provider-free CLI check through `mycli.cli.main.main(... cwd=<tmp workspace>)`
  - Result: `mcp inspect disabled --json` returned status `disabled` without requiring API key

## Notes

- `mycli mcp` command handlers are provider-free and run before model/runtime construction.
- MCP failure diagnostics are bounded and redacted.
- Provider-free smoke now verifies enabled, disabled, and broken local stdio server paths.
