# Plugin Command Surface P1 PRD

## Objective

Extend the local plugin runtime from hook/tool registration to a minimal,
Hermes-like command surface. This feature must stay local, provider-free for
management/execution commands, and isolated from marketplace, MCP, ACP,
subagent, and provider plugin productization.

## Scope

### Manifest

- `plugin.yaml` supports `provides_commands`.
- `provides_commands` may be a list of strings or command objects.
- Command objects must preserve at least id/name, description, kind, and
  schema fields when present.
- Malformed manifest fields are diagnostics, not process-fatal errors.
- `plugins list|inspect` includes command declarations and registered commands.

### Runtime Registration

- `PluginContext.register_command(name, schema, handler, metadata=None)` is
  available to enabled plugins.
- Commands use stable ids: `plugin:<plugin_id>:<command_name>`.
- Registration validates non-empty command names and object schemas.
- Duplicate command ids are isolated as diagnostics; the first registration
  wins.
- Handler exceptions return structured failures and do not corrupt
  turn/session state.

### Execution Surfaces

- Provider-free CLI:
  `mycli plugins run <plugin_id> <command_name> [--json-args JSON] [--json]`.
- Slash command:
  `/plugin <plugin_id> <command_name> [json-args]`.
- Execution result shape includes `ok`, `summary`, `content`, `metadata`, and
  `error`.
- Human output is bounded and does not expose raw tracebacks, secrets, tokens,
  API keys, or environment variable values.

### Diagnostics

- Doctor includes plugin command diagnostics through the existing `plugins`
  check.
- CLI/doctor can report duplicate command, invalid schema, register failure,
  missing env, and disabled plugin/command states.
- Diagnostics remain provider-free and must not build a model provider.

## Non-Goals

- Plugin marketplace install/update/remove.
- Remote plugin loading.
- MCP/ACP/subagent/plugin gateway adapter productization.
- Rich TUI visual polish or interactive argument completion.
- Copying Hermes-agent code.

## Acceptance Criteria

- Feature branch is committed and not merged to `main`.
- `plugin.yaml` supports `provides_commands`.
- `PluginContext.register_command()` works for enabled plugins.
- Enabled demo plugin can register and execute a command.
- Unenabled/disabled plugins do not load commands.
- `mycli plugins list|inspect` display commands in human and JSON output.
- `mycli plugins run ...` executes provider-free and handles invalid JSON.
- `/plugin ...` executes through the existing slash command handler.
- Command registration/execution errors are visible through CLI/doctor tests.
- Provider-free smoke covers disabled-by-default, enabled registration,
  inspect, command execution, and disabled override.
- Focused tests, `ruff`, `mypy`, and full Python tests pass.
