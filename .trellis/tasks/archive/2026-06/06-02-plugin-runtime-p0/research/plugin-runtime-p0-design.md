# Plugin Runtime P0 Research

## Hermes reference semantics

Hermes plugin runtime centers on these contracts:

- Directory plugin shape: `plugin.yaml` plus `__init__.py` with `register(ctx)`.
- Discovery sources include bundled/user/project/pip plugins, but P0 for mycli should only use repo and user plugins.
- Plugins are opt-in by config. Disabled entries explicitly block loading.
- `PluginContext` is a narrow host-owned facade; plugins do not mutate core globals directly.
- P0-relevant context methods are `register_hook(...)` and `register_tool(...)`.
- Load failures and manifest failures are diagnostic state, not process-fatal errors.

## Existing mycli fit

- `HookManager.register(HookPoint, callback, name=...)` can host plugin hooks without changing domain hook models.
- `ToolRegistry.register(SchemaTool)` can host plugin tools. P0 can wrap plugin handlers in a `SchemaTool` adapter.
- `ToolRegistry.manifest_issues()` already permits `source=plugin`, but `_manifest_entry()` currently emits `source=builtin` for every local registry tool. Plugin tool source needs metadata support.
- Doctor has collector pattern and can add `_check_plugins` without starting runtime/provider.
- Utility CLI command handling already supports `hooks` provider-free; `plugins` can follow the same shape.
- Existing config resolution reads project and user TOML internally but does not expose plugin settings. Plugin runtime can use a dedicated read-only config loader for `plugins.enabled` / `plugins.disabled` to avoid expanding `AgentConfig` yet.

## P0 design decisions

- Plugin directories:
  - repo: `<workspace>/.mycli/plugins/<plugin_id>/`
  - user: `<home>/.mycli/plugins/<plugin_id>/`
- Config keys:
  - `[plugins] enabled = ["demo"]`
  - `[plugins] disabled = ["demo"]`
  - explicit disabled wins over enabled.
- Duplicate ids/names:
  - deterministic resolution: user source overrides repo source for the same plugin id.
  - duplicate is still reported as an issue in CLI/doctor.
- Manifest fields:
  - required-ish: `name`
  - optional with defaults: `version`, `description`, `kind`, `provides_tools`, `provides_hooks`, `requires_env`
  - plugin id is directory name, not the manifest display name.
- Loading:
  - only enabled and not disabled candidates load.
  - load `__init__.py` through `importlib.util.spec_from_file_location` under an internal module namespace.
  - call `register(ctx)` if callable; otherwise mark load error.
  - catch exceptions and store bounded error type/message without traceback.
- Hook integration:
  - `ctx.register_hook(hook_point, callback, name=None)` accepts existing hook point strings or `HookPoint`.
  - callback must return `HookResult` or compatible dict/string; P0 can keep direct `HookResult` for tests/smoke and defensive conversion for dicts.
- Tool integration:
  - `ctx.register_tool(name, schema, handler, metadata=None)` creates a `PluginTool` wrapper.
  - schema supports description, parameters, risk_level. Handler receives arguments and returns `ToolResult`, dict, or string.
  - plugin tool metadata marks `source=plugin`, `toolset=plugin`, `origin_plugin=<id>`.
- Management:
  - `mycli plugins list/inspect [--json]` should use discovery only; for load status it may attempt provider-free load into temporary `HookManager`/`ToolRegistry` to surface load errors and registered tools/hooks.
- Runtime:
  - during runtime bootstrap, load enabled plugins into the real `HookManager` and `ToolRegistry` after built-in/config hooks and before turns execute.

## Out of scope

- Plugin install/update/remove marketplace.
- Pip entry points.
- Gateway/platform adapters.
- MCP/ACP/subagent productization.
- Arbitrary plugin LLM facade.
