# Plugin Runtime P0

## Goal

Implement a minimal Hermes-like plugin host for mycli on top of the completed
configured hook and hook-management foundation. The result should let an enabled
repo/user plugin load `plugin.yaml` plus `register(ctx)`, register hooks and
provider-free local tools, and be diagnosable through CLI and doctor.

This is not a marketplace and does not productize MCP, ACP, subagents, gateway
platforms, or provider plugins.

## Scope

### Plugin manifest

- Discover repo plugins from `<workspace>/.mycli/plugins/<plugin_id>/`.
- Discover user plugins from `<home>/.mycli/plugins/<plugin_id>/`.
- A directory plugin contains `plugin.yaml` and `__init__.py`.
- Manifest fields:
  - `name`
  - `version`
  - `description`
  - `kind`
  - `provides_tools`
  - `provides_hooks`
  - `requires_env`
- Manifest parse errors must become bounded diagnostics instead of process
  crashes.

### Discovery / enablement

- Plugins are opt-in by config.
- Read enablement from existing config locations:
  - repo `<workspace>/.mycli/config.toml`
  - user `<home>/.config/mycli/config.toml`
- Support `[plugins] enabled = [...]` and `[plugins] disabled = [...]`.
- Disabled wins over enabled.
- Deterministic duplicate id handling: user plugin overrides repo plugin for the
  same plugin id, while duplicate diagnostics remain visible.
- Missing `__init__.py`, missing env vars, duplicate ids/names, and malformed
  manifests must be visible in CLI/doctor.

### PluginContext / register(ctx)

- Load enabled plugin `__init__.py` and call `register(ctx)`.
- Provide minimal `PluginContext`:
  - `register_hook(hook_point, callback, name=None)`
  - `register_tool(name, schema, handler, metadata=None)`
- Plugin exceptions must be isolated and recorded as load diagnostics.
- Keep architecture boundaries: domain remains independent from infrastructure;
  plugin loading belongs under services/infrastructure-facing code.

### Hook integration

- Plugin hooks register into existing `HookManager`.
- Plugin hook results use existing `HookResult` / `HookAction` semantics.
- Plugin hooks appear in `/hooks` via `HookManager.snapshot()` after runtime
  load, and in plugin CLI/doctor diagnostics.
- Hook diagnostics must not include raw tool args, hook stdin, environment, or
  secrets.

### Tool integration

- Plugin tools register into existing `ToolRegistry`.
- Provide a provider-free demo-capable tool wrapper.
- Tool manifest/diagnostics must identify plugin origin/source.
- Plugin tool handler failures must return a safe `ToolResult` and must not
  corrupt turn/session state.

### Plugin management CLI

- Add:
  - `mycli plugins list [--json]`
  - `mycli plugins inspect <plugin_id> [--json]`
- Output fields:
  - source
  - plugin_id
  - name
  - version
  - kind
  - enabled
  - load_status
  - provided_tools
  - provided_hooks
  - issues
- CLI must be provider-free and must not initialize agent runtime.
- Do not add install/update/remove marketplace commands.

### Doctor / diagnostics

- Add a `plugins` doctor check.
- Report manifest parse error, disabled plugin, load error, missing required env,
  duplicate id/name.
- Output must be bounded/redacted and must not print traceback or secrets.

## Acceptance Criteria

- Unit tests cover manifest parsing, discovery, enable/disable, duplicate
  diagnostics, missing env diagnostics, load failure, register hook, register
  tool, plugins CLI human/JSON output, and doctor diagnostics.
- Provider-free smoke creates a temporary demo plugin and proves:
  - not enabled -> not loaded
  - enabled -> `register(ctx)` called
  - enabled hook executes
  - enabled tool is discovered and executable
  - disabled -> not loaded
- Existing hook management CLI, doctor, and `/hooks` behavior remain compatible.
- `ruff`, `mypy`, focused tests, provider-free smoke, and full Python unit +
  integration tests pass.
- Trellis task is archived and the feature branch is committed.
