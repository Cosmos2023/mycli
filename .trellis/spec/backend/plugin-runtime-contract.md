# Plugin Runtime Contract

## Overview

`mycli` supports a minimal local plugin runtime for enabled repo/user directory
plugins. The runtime is a provider-free extension host: it discovers plugin
manifests, loads enabled `register(ctx)` modules, and lets plugins register
hooks and local tools through host-owned facades.

This contract is intentionally smaller than Hermes-agent. It does not implement
marketplace install/update/remove, pip entry points, MCP/ACP/subagent
productization, gateway adapters, provider plugins, or an LLM facade.

## Directory And Config Shape

- Repo plugins live under `<workspace>/.mycli/plugins/<plugin_id>/`.
- User plugins live under `<home>/.mycli/plugins/<plugin_id>/`.
- A directory plugin contains:
  - `plugin.yaml`
  - `__init__.py` with callable `register(ctx)`
- Enablement is read from existing TOML config files:
  - repo `<workspace>/.mycli/config.toml`
  - user `<home>/.config/mycli/config.toml`
- Supported keys:
  - `[plugins] enabled = ["demo"]`
  - `[plugins] disabled = ["demo"]`
- Plugins are opt-in. Disabled wins over enabled.

## Manifest Contract

`plugin.yaml` supports:

- `name`
- `version`
- `description`
- `kind`
- `provides_tools`
- `provides_hooks`
- `requires_env`

Manifest parse errors, missing `__init__.py`, missing required env vars,
duplicate ids/names, module load errors, and `register(ctx)` failures must be
reported as bounded diagnostics, not process-fatal errors.

Duplicate plugin ids resolve deterministically: user source overrides repo
source. The duplicate remains diagnostic-visible.

## Runtime Contract

Enabled plugins are loaded into real runtime registries before turns execute:

- `PluginContext.register_hook(...)` registers into `HookManager`.
- `PluginContext.register_tool(...)` registers a local `SchemaTool` into
  `ToolRegistry`.

Plugin hook and tool exceptions must be isolated:

- hook exceptions return `HookAction.ERROR`
- tool exceptions return unsuccessful `ToolResult`
- neither path may corrupt turn/session state

Plugin tool manifest entries must use `source="plugin"` and stable ids of the
form `plugin:<plugin_id>:<tool_name>`.

## Diagnostics Contract

- `mycli plugins list|inspect [--json]` is provider-free and must not build
  `AgentRuntime`.
- `doctor` includes a `plugins` check and must not start provider/model work.
- Human and JSON diagnostics may expose bounded plugin ids, source, names,
  status, registered hooks/tools, and issue summaries.
- Diagnostics must not print raw tracebacks, plugin raw exception messages,
  environment values, tokens, or secret-like payloads.

## Required Tests

- Manifest parse success and malformed manifest diagnostics.
- Repo/user discovery, explicit enable/disable, duplicate id/name reporting.
- Load failure and missing env diagnostics.
- `register(ctx)` hook and tool registration.
- Plugin tool manifest source/id metadata.
- `mycli plugins` human and JSON output.
- Doctor plugin diagnostics.
- Runtime initialization loads enabled plugin hooks/tools.
- Provider-free smoke proving disabled-by-default, enabled load, hook execution,
  tool execution, and disabled override.
