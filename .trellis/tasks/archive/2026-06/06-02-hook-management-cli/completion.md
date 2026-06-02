# Hook Management CLI Completion

## Summary

- Added `mycli hooks list|inspect|approve|revoke` as provider-free utility commands.
- Added structured hook management service output for human and JSON renderers.
- Added targeted `HookAllowlist.approve()` and `HookAllowlist.revoke()` helpers without changing the allowlist JSON format.
- Added unit coverage for list, inspect, approve, revoke, JSON output, malformed config, digest mismatch, and built-in hook rejection.
- Added provider-free smoke coverage for approve -> configured hook executes and revoke -> configured hook no longer executes.

## Verification

- `uv run ruff check src tests evaluation/hook_management_smoke.py`
- `uv run mypy src/mycli`
- `uv run pytest tests/unit/services/test_hook_management.py tests/unit/cli/test_hooks_cli.py tests/unit/services/test_configured_hooks.py tests/unit/cli/test_main.py tests/unit/services/test_doctor_service.py -q`
- `uv run pytest tests/unit tests/integration -q`
- `uv run python evaluation/hook_management_smoke.py`

## Remaining Hermes Gaps

- This does not implement a plugin marketplace, plugin manifest loader, or `register(ctx)` extension context.
- Hook lifecycle remains focused on configured local hooks and existing runtime hook points.
- Plugin-provided tools, slash commands, provider backends, and gateway adapters remain future work.

## Next Plugin Recommendation

Build a minimal plugin manifest/runtime layer next:

1. Discover enabled plugins from user and repo plugin directories.
2. Load `plugin.yaml` plus `register(ctx)` safely.
3. Let `PluginContext` register hooks and tools through existing registries.
4. Add `mycli plugins list/inspect/enable/disable` only after the runtime context exists.
