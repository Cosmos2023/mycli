# Plugin Command Surface P1 Research

## Current mycli Baseline

- `feature/mycli-plugin-runtime-p0` provides local directory plugin discovery,
  enablement, `PluginContext.register_hook()`, and
  `PluginContext.register_tool()`.
- Enabled plugins are loaded by `load_enabled_plugins()` into runtime-owned
  `HookManager` and `ToolRegistry`.
- Provider-free plugin management lives in `PluginManagementService` and
  `mycli plugins list|inspect`.
- Plain REPL, Textual TUI fallback, and Node TUI command RPC all route slash
  commands through `src/mycli/cli/repl.py::build_command_handler`.
- Node TUI uses JSON-RPC `command.run` and calls the same command handler, so
  adding `/plugin ...` there gives a minimal in-session command surface without
  UI-specific work.

## Hermes Reference Boundary

Hermes-agent has a mature plugin/extension posture with plugin metadata and
runtime-facing extension points. For this P1 slice, use the semantics only:
plugins should be able to declare commands, register host-executed callbacks,
and surface bounded diagnostics. Do not copy Hermes code and do not implement
marketplace, remote loading, provider plugins, MCP/ACP, or subagent
productization.

## Chosen Design

Add a local plugin command registry under `mycli.services.plugins.commands`.
The registry is provider-free and owns:

- command registration rows
- stable ids: `plugin:<plugin_id>:<command_name>`
- manifest rows with `source=plugin`
- duplicate detection
- structured execution results: `ok`, `summary`, `content`, `metadata`,
  `error`

Extend `PluginContext` with:

```python
register_command(name, schema, handler, metadata=None)
```

`load_enabled_plugins()` accepts an optional `PluginCommandRegistry`. Runtime
initialization supplies a real registry; management/doctor/CLI also supply a
registry so diagnostics are consistent without starting providers.

Provider-free command execution is exposed via:

- `mycli plugins run <plugin_id> <command_name> [--json-args JSON] [--json]`
- `/plugin <plugin_id> <command_name> [json-args]`

This keeps the first slash surface explicit and avoids colliding with built-in
slash commands. TUI clients already route unknown slash commands to
`build_command_handler`, so Node TUI can execute `/plugin ...` through the
existing `command.run` RPC.

## Validation Targets

- manifest parse supports `provides_commands`
- disabled plugins do not load commands
- enabled plugin commands execute with structured results
- duplicate command ids are diagnostic-visible and do not crash the runtime
- handler exceptions are isolated and redacted
- `plugins list|inspect` displays commands
- `plugins run` is provider-free
- `/plugin ...` works through command handler
- doctor reports command registration issues
