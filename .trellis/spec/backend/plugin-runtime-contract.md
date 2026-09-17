# Plugin Runtime Contract

## Overview

The repository supports Codex-style capability bundles and process-isolated Plugin API v2 for
compiled ESM. Bundles feed the existing skill/MCP/configured-hook systems. Legacy Python plugin
directories are discovery-only migration candidates; Node never imports or spawns their source.

Plugin package management supports local/Git installation, marketplaces, update/remove and
enable/disable. OpenAI-hosted Apps, ACP, provider plugins, and an LLM facade are not implemented.

## Directory And Config Shape

- Repo plugins live under `<workspace>/.mycli/plugins/<plugin_id>/`.
- User plugins live under `<home>/.mycli/plugins/<plugin_id>/`.
- A v2 directory plugin contains `plugin.yaml` plus a relative compiled `.js` or `.mjs` entry.
- Enablement is read from existing TOML config files:
  - repo `<workspace>/.mycli/config.toml`
  - user `<home>/.mycli/config.toml`, falling back to `<home>/.config/mycli/config.toml`
- Supported keys:
  - `[plugins] enabled = ["demo"]`
  - `[plugins] disabled = ["demo"]`
- Unmanaged directory plugins are opt-in. Managed installation enables a package by default;
  explicit config overrides that default and disabled wins over enabled.

## Capability Bundles And Packages

- Recognize `.codex-plugin/plugin.json` and `.claude-plugin/plugin.json`. Resolve component paths
  beneath the real package root. Default components are `skills/`, `.mcp.json`, `hooks/hooks.json`
  and `.app.json`. Apps produce `plugin_apps_unavailable`; they never appear usable.
- One discovery per configuration generation is shared across bundle skills, MCP, hooks and PluginRuntime. Disabled or
  untrusted repository bundles contribute nothing. Invalid component entries remain diagnostic
  visible and give the bundle `partial` status while valid entries can load.
- Skill references use `plugin:skill` or `plugin@marketplace:skill`; `isSkillReferenceName` in core
  owns validation at activation, durable context and transcript boundaries. Prefix source paths
  within the skill body bound. Never let a qualified name silently lose its instructions.
- Qualified plugin tool/command routes use a deterministic safe internal namespace; display and
  command lookup preserve the original plugin id. Bundle MCP ids isolate identical server names.
  Include package cwd/description in the MCP catalog fingerprint to invalidate updated snapshots.
- Installation copies data only, with no ESM import, MCP start, hook execution, lifecycle script,
  or submodule execution. Bound entry/byte counts, reject escaping symlinks and cycles, and disable
  Git user config/templates/hooks. Cancellation/timeout terminates Git's process tree.
- `~/.mycli/plugin-registry.json` is private, locked and atomically replaced. New immutable cache
  snapshots commit only after validation and an expected previous-cache check. On failure or
  cancellation remove only the uncommitted stage. Prior snapshots survive update/remove for
  active sessions; there is currently no automatic cache GC.
- Enablement is one atomic config write, preserving unrelated and legacy user config. It must not
  depend on a partially committed second file. Unknown ids fail; project-disabled overrides are
  reported rather than claiming successful activation.
- `plugins list --available [--marketplace name]` lists marketplace entries. Without `--available`,
  the same filter lists installed/discovered plugins. Marketplace upgrade refreshes the catalog;
  package update is separate. Marketplace removal retains installed packages.
- Regressions cover package defaults, realpath aliases/escapes/cycles, cancellation, failed update,
  concurrent commits, qualified names, actual MCP/hook execution, trust/enablement, CLI routing,
  and skill instructions surviving runtime context validation.

## Interactive Package Management

### Scope / Trigger

Changes to the plugin browser, package metadata, typed plugin RPCs or cancellable package work.

### Signatures

- `PluginCatalogService.list(signal, marketplace?) -> PluginCatalog`.
- `PluginCatalogService.inspect(target, revision, signal) -> PluginDetail`.
- `PluginCatalogService.change(change, signal) -> PluginPackageResponse`.
- Gateway: `plugin.catalog`, `plugin.inspect`, `plugin.operation.start/get/cancel`.
- TUI: `MycliShellPluginManager` in `model.ts`; application owns the gateway adapter and selectors
  consume only this port and contract types.

### Contracts

- `PluginCatalogService` reads metadata only. Reuse `pluginDeclarations` for CLI/resource and TUI
  capability names. Browsing never starts hosts, MCP clients, hooks or model calls.
- `plugin.catalog` lists bounded metadata (2,048 entries / 6 MiB), registered marketplaces, safe
  issues, trust visibility and explicit omissions. Named-marketplace queries narrow large lists.
  `plugin.inspect` validates the selected revision and returns bounded full capability names on demand.
- Preserve stable qualified IDs and source/configuration/marketplace revisions. A changed revision
  requires refreshed user selection; package manager commit still checks the previous cache key.
  A marketplace replaced during staging cannot authorize an install from the retired catalog.
- `plugin.operation.start/get/cancel` separates long package work from the gateway response deadline.
  The controller owns one mutation, 32 retained outcomes, original session/generation, a five-minute
  staging timer and cleanup. Matching retained IDs deduplicate; different payload reuse fails.
- Closing/switching/shutdown cancels pending work. Successful commit wins a late cancellation;
  unknown transport outcome is never automatically retried. An attachment disconnect alone keeps
  normal backend ownership. Observer clients only list/inspect/query outcomes.
- UI installed/enablement labels describe package configuration. Runtime health stays separately
  available; metadata-only inspection must not imply verified live capability activation.
- Tests use temporary homes/local packages and prove partial marketplace failure, stale revision,
  concurrent marketplace replacement, cancellation, no host startup and retained installed packages
  after marketplace removal. Keep full gateway/TUI journeys provider-free.

### Validation & Error Matrix

| Input/state | Outcome |
| --- | --- |
| Invalid action, source bound or missing ownership/revision | Contract rejection before dispatch |
| Session/generation changed | `session_changed`; no package mutation |
| Selection revision changed | `plugin_catalog_changed`; refresh and review again |
| Marketplace/package replaced during staging | `plugin_install_conflict`; remove uncommitted stage |
| Another operation is running | `gateway_overloaded`, `dispatched=false` |
| Cancel before commit / cancel after commit | `cancelled` after cleanup / preserve `completed` |
| Result/connection is lost | Unknown outcome; inspect the catalog, never replay automatically |

### Good / Base / Bad Cases

- Good: retain original session/generation for polling and cancellation after a UI session switch.
- Base: an empty catalog offers source installation and Add Marketplace without a model turn.
- Bad: await Git cloning inside an ordinary long-lived RPC response or start plugin hosts to list metadata.

### Tests Required

- `plugin-catalog.integration.test.ts`: metadata-only discovery, trust, source revision/commit races,
  malformed marketplace isolation, declared names and large catalog narrowing.
- `plugin-gateway.integration.test.ts`: typed installation, responsive status, operation identity,
  cancellation, successful commit precedence and session transition cancellation.
- Plugin selector/client/runtime tests: explicit actions, removal confirmation, deferred detail,
  original session ownership, draft retention, close/resize/Unicode/monochrome behavior.
- Run architecture, generated contract/catalog drift and error-emitter inventory checks.

### Wrong vs Correct

Wrong: a selector imports its callback type from `application/plugin-manager-client.ts` and thereby
depends on the application layer. Correct: put `MycliShellPluginManager` in `model.ts`; both the
selector and application adapter depend on that stable port.

## MCP Authentication And Live Configuration

- `pluginMcpServers(discovery, env)` normalizes bundle MCP declarations without executing code.
  `discoverConfiguredMcpServers(options, discovery?)` is the shared authority for runtime and MCP
  management. Preserve plugin discovery diagnostics and per-server normalization failures.
- Preserve stable `pluginMcpServerId(pluginId, serverName)` identities. Add structured plugin
  ID/source/raw-server provenance and accept the readable `pluginId/serverName` selector in
  list/inspect, login/logout and revocation. An exact standalone ID override wins and does not
  inherit plugin aliases or credentials. Required plugin failures use the stable internal ID.
- Normalize bundle OAuth `clientId`/`callbackPort` aliases with canonical snake-case keys winning.
  The per-server callback setting is a documented mycli extension to the inspected Codex behavior.
  OAuth management starts no plugin worker, hook, model or unrelated MCP client.
- Bind plugin credentials to plugin ID/source/raw server plus normal endpoint/header/OAuth
  identity, excluding the immutable package cache path. Bind MCP tool approvals to the full
  configuration/package/schema fingerprint; a preserved OAuth login does not preserve approval.
- `loadRuntimeIntegrationConfiguration` fingerprints effective plugin discovery, MCP config and
  the private OAuth directory modification stamp. Read no credential values into the fingerprint
  or diagnostics. Unchanged configurations keep their clients. Standalone skill/hook file edits
  are not watched independently by this package-change mechanism.
- `RuntimeIntegrationComposition.prepareRun(owner, signal)` serializes configuration refresh
  before catalog capture, then retains ownership. `finishRun(owner)` releases it. Session/turn
  owner keys are collision-safe; plugin commands acquire their own temporary owner.
- Each session owns its content, clients, Skill adapter, hook runner and refresh queue. Only that
  session's active/suspended turns and plugin commands defer its replacement. A waiting child must
  not block its parent's next turn or idle inspection. MCP elicitation retains its calling client.
  Explicit workspace trust changes keep their existing immediate trust-gating behavior.
- The backend owns one shared Agent supervisor. Session composition cleanup never closes it.
  Async runtime preparation coalesces by session; transcript inspection starts no integration
  processes. Resume reuses a live binding. Shutdown fences new preparation, cancels discovery,
  closes the supervisor, and drains all session content before Workers and stores.
- A child starts separate clients from its parent's captured configuration and pins that content.
  Persist only configuration and full tool-definition/approval-scope fingerprints in child spawn
  authority. On reload, changed or unavailable authority disables integrations before startup;
  legacy name-only children retain built-in tools. A fresh spawn can inherit updated integrations.
  Schema changes cannot borrow a same-name grant; Skill authority includes the rendered catalog.
- Gateway inspection and plugin commands select one session owner; command execution retains that
  owner through await. Extension events from other sessions are filtered, and session activation
  refreshes the selected catalog. Read-only history has no executable integration binding.
- On a configuration change, finish MCP discovery and validate required servers before publishing
  replacement tools/skills/hooks/commands/resources. Candidate failure closes candidate clients,
  retains the previous content and rejects the refresh. Optional server failures stay isolated.
  Once published, retire/close prior content; stale callbacks cannot change the new catalog.
- Idle integration slash inspections and `resource.list` invoke the same refresh boundary. Keep
  `/plugins`, `/mcp`, `/skills`, `/hooks` and diagnostic `/tools` distinct. `/mcp` uses readable
  plugin selectors, preserving the opaque ID in its inspection detail.
- Cancellation must not add a run owner after preparation; failure must not strand an owner.
  Shutdown aborts candidate discovery/loading, drains replacement work, and fences publication.
  Immutable package snapshots remain retained on disk; automatic GC is not implemented.
- Regressions cover real loopback login/logout, trust/disable/overrides, credential/approval
  identity, package lifecycle, multiple owners, continuation/interruption cleanup, failed/cancelled
  preparation, concurrent refresh, shutdown, and a same-backend SDK/gateway update during approval.

## Manifest Contract

`plugin.yaml` declares `api_version: 2`, `id`, `name`, optional `version`/`description`, compiled
`entry`, `provides.tools/hooks/commands`, `requires_env`, and `capabilities`.

Manifest parse errors, missing or unsafe entries, missing required env vars, duplicate ids/names,
worker startup failures, and protocol failures must be reported as bounded diagnostics, not
process-fatal errors.

Duplicate plugin ids resolve deterministically: user source overrides repo
source. The duplicate remains diagnostic-visible.

## Runtime Contract

Validated worker registrations are adapted into the real hook, tool, and command registries before
turns execute.

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
- `/plugins` is the in-session plugin catalog. Registered command routes use
  `/plugin:<plugin_id>:<command_name> [json-args]`; the historical `/plugin ...` alias is not public.
- `doctor` includes a `plugins` check and must not start provider/model work.
- Human and JSON diagnostics may expose bounded plugin ids, source, names,
  status, registered hooks/tools, and issue summaries.
- Diagnostics must not print raw tracebacks, plugin raw exception messages,
  environment values, tokens, or secret-like payloads.
- Tools, hooks, and commands convert process failures at the adapter boundary using existing
  `integration.*` reasons. Retain bounded phase, operation, timeout, numeric exit code, allowlisted
  signal/errno, and one prior failure. The host owns `error_context`; discard plugin-supplied values.
- A process host retains its first terminal failure. A dispatched invocation that times out or
  loses its process has an unknown outcome and possible effects. Never automatically replay it.
- `RecoverablePluginHost` may replace a failed process for a subsequent invocation after
  `worker_exited`, `call_timeout`, `startup_timeout`, or cancellation (`host_closed`). Startup must
  reproduce the complete original registration set, including schemas. Protocol corruption and
  registration drift require explicit configuration/runtime reload.
- Concurrent new invocations share one replacement. Individual cancellation releases only that
  waiter; the last waiter cancels startup. A later caller waits for abandoned startup cleanup.
  Closing fences initialization and all dispatch; it cannot publish a late ready state.
- Runtime records and `/plugins` resources derive from current host state (`loaded`,
  `loading`, `error`, `closed`), independent of configured enablement. Subscription updates must not
  fire for successful calls with unchanged state; retired content cannot republish stale resources.
  Resource selector labels and colors give unhealthy/loading/closed status precedence over the
  configured `enabled` flag; a crashed enabled plugin cannot appear as a healthy `on` resource.
- A plugin pre-hook failure scopes the blocked tool to `not_started/none` and preserves the hook's
  own possible effects as a separate cause. A post-hook failure cannot rewrite a committed tool result.

## Required Tests

- Manifest parse success and malformed manifest diagnostics.
- Repo/user discovery, explicit enable/disable, duplicate id/name reporting.
- Load failure and missing env diagnostics.
- v2 hook/tool/command registration and structured command execution.
- Duplicate command id and handler exception diagnostics.
- Plugin tool manifest source/id metadata.
- Plugin command manifest source/id metadata.
- `mycli plugins` human and JSON output.
- Doctor plugin diagnostics.
- Runtime initialization loads enabled v2 plugin hooks/tools.
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
- Legacy Python plugins are not executable. Node discovery reports them as `migration_required` and
  does not import or spawn them; no source-compatible execution or fallback path exists.

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
