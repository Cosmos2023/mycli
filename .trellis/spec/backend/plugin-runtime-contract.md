# Plugin Runtime Contract

## Overview

The repository has two intentionally separate local plugin contracts. The
independently launched Python reference runtime retains enabled repo/user
`register(ctx)` plugins. The npm CLI starts only Node, which uses process-isolated
Plugin API v2 for compiled ESM and never imports Python plugin source.

Neither runtime implements marketplace install/update/remove, ACP, provider
plugins, or an LLM facade.

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
- `provides_commands`
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
- `PluginContext.register_command(...)` registers a provider-free local command
  into `PluginCommandRegistry`.

Plugin hook, tool, and command exceptions must be isolated:

- hook exceptions return `HookAction.ERROR`
- tool exceptions return unsuccessful `ToolResult`
- command exceptions return a structured unsuccessful `PluginCommandResult`
- neither path may corrupt turn/session state

Plugin tool manifest entries must use `source="plugin"` and stable ids of the
form `plugin:<plugin_id>:<tool_name>`.

Plugin command manifest entries must use `source="plugin"` and stable ids of
the form `plugin:<plugin_id>:<command_name>`. Command execution results are
provider-free structured payloads with `ok`, `summary`, `content`, `metadata`,
and `error`.

## Diagnostics Contract

- `mycli plugins list|inspect [--json]` is provider-free and must not build
  `AgentRuntime`.
- `mycli plugins run <plugin_id> <command_name> [--json-args JSON] [--json]`
  is provider-free and executes enabled plugin commands through the same local
  command registry.
- `/plugin <plugin_id> <command_name> [json-args]` is the minimum in-session
  slash command surface for plugin commands.
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
- `register(ctx)` command registration and structured command execution.
- Duplicate command id and handler exception diagnostics.
- Plugin tool manifest source/id metadata.
- Plugin command manifest source/id metadata.
- `mycli plugins` human and JSON output.
- Doctor plugin diagnostics.
- Runtime initialization loads enabled plugin hooks/tools.
- Provider-free smoke proving disabled-by-default, enabled load, hook execution,
  tool execution, command execution, and disabled override.

## Scenario: Node Plugin API v2 Process Host And Migration

### 1. Scope / Trigger

- Trigger: changes to Node plugin discovery, `plugin.yaml`, generated Plugin v2 schemas, worker
  bootstrap, process sandboxing, plugin registrations, invocation, shutdown, or migration output.
- Plugin files and process output are untrusted input. Validation, isolation, bounds, and cleanup
  are part of the public runtime contract rather than implementation details.

### 2. Signatures

- `loadPluginManifest({pluginRoot, source}) -> PluginManifestLoadResult`.
- `PluginProcessHost.start(signal) -> Promise<PluginProtocolRegistration[]>`.
- `PluginProcessHost.invoke(target, input, signal) -> Promise<PluginInvocationResult>`.
- `PluginProcessHost.close() -> Promise<void>`.
- Protocol messages: `initialize`, `registered`, `invoke`, `result`, `error`, `shutdown`, and
  `shutdown_complete`, all with `version=2` and a bounded `request_id`.
- Management: `mycli plugins list|inspect|run ... [--json]` before provider/TUI startup.

### 3. Contracts

- Node plugins live under `<workspace>/.mycli/plugins/<id>` or `<home>/.mycli/plugins/<id>`, use
  `plugin.yaml` with `api_version: 2`, and point `entry` to a relative `.js`/`.mjs` file contained
  by the real plugin root. Raw TypeScript and Python entries are not executable Node plugins.
- The manifest declares `provides.tools/hooks/commands`, `requires_env`, and bounded capabilities.
  Worker registrations must match those declarations exactly; undeclared, missing, duplicate, or
  mismatched routes fail the plugin without partially retaining registrations.
- Each plugin runs in its own sandboxed Node child. The host sends newline-delimited closed-schema
  JSON messages on stdin/stdout, correlates every response by request id, caps outstanding calls,
  line/stderr bytes, startup/call/shutdown time, and terminates the complete process tree on abort,
  timeout, protocol failure, or close.
- Only the declared required environment names are forwarded in addition to the minimal process
  environment. Capabilities determine sandbox filesystem/network/process permissions; sandbox
  construction failure never falls back to an unrestricted process.
- Worker stdout is protocol-only. Console diagnostics go to bounded stderr and are never surfaced
  raw through management, doctor, gateway, tool results, or provider-visible text.
- Valid tools, hooks, and commands are adapted through host-owned registries. Hook execution order
  is built-in, then configured command hooks, then Plugin API v2 hooks. `modify` results feed the
  next hook; deny/error stops fail-closed hook points before later sources run.
- Python plugins belong only to the independently launched Python reference runtime. Node discovery
  reports them as `migration_required` and does not import or spawn them. The npm CLI has no Python
  sidecar, backend selector, automatic fallback, or source-compatible Python plugin execution path.

### 4. Validation & Error Matrix

- Unsupported API version, unsafe entry, invalid UTF-8/YAML, symlink escape, missing file, or id
  mismatch -> bounded discovery issue; do not import the entry.
- Sandbox unavailable or spawn failure -> plugin record `failed`; continue isolating other plugins.
- Registration differs from manifest declarations -> `registration_mismatch`; terminate worker and
  retain no routes from it.
- Invalid JSON/UTF-8/schema, wrong message type, unknown request id, stdout/stderr overflow, or worker
  exit -> fail the host and reject pending calls with a stable `PluginHostError.kind`.
- Startup/call timeout -> `startup_timeout` / `call_timeout`; abort -> terminate the process tree and
  preserve `AbortError` semantics.
- Python source plugin in Node discovery -> `migration_required`, never an execution attempt.

### 5. Good/Base/Bad Cases

- Good: a compiled ESM worker declares and registers one tool, one hook, and one command, serves
  correlated calls, receives shutdown, and leaves no child process.
- Good: one plugin crashes while another continues serving its own routes and management commands.
- Base: no enabled v2 plugins yields an empty plugin contribution and provider-free management
  output.
- Bad: import the plugin entry in the CLI/backend process to inspect registrations.
- Bad: execute a legacy `__init__.py` from Node or silently omit its migration diagnostic.
- Bad: allow worker console output to share stdout with the protocol or print it in doctor output.

### 6. Tests Required

- Generated manifest/protocol contract tests accept every valid message variant and reject open,
  incomplete, unsafe, duplicate, and oversized values.
- Manifest/discovery tests cover precedence, enablement, realpath containment, symlink escapes,
  migration diagnostics, malformed input, and no-import discovery.
- Process-host integration tests cover concurrent correlation, registration freeze/mismatch,
  unknown ids, floods, crashes, timeouts, cancellation, process-tree cleanup, and idempotent close.
- Runtime tests cover tool/hook/command adapters, source isolation, route conflicts, configured hook
  ordering, and no partial registrations after failure.
- Packed-package smoke resolves the compiled worker bootstrap from `@mycli/integrations` and runs
  compiled plugin management commands without Python.

### 7. Wrong vs Correct

#### Wrong

```typescript
const module = await import(manifest.entryPath);
await module.register(hostContext); // Imports untrusted code into the backend process.
```

#### Correct

```typescript
const host = new PluginProcessHost({ manifest, sandboxProfile });
const registrations = await host.start(signal);
// Invoke only validated registration tokens over Plugin API v2.
```
