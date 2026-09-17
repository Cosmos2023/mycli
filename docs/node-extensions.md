# Node Extensions

The M8 Node-only runtime discovers skills, MCP servers, Plugin API v2 workers, and configured hooks
before a turn. Management and doctor commands use the same discovery services,
but do not construct a provider or start the interactive runtime.

## Discovery And Precedence

| Capability | User path | Repository path | Precedence |
| --- | --- | --- | --- |
| Hooks | `~/.mycli/hooks.json` | `<workspace>/.mycli/hooks.json` | Both sources load; hook ids must be unique within each file |
| MCP | `~/.mycli/mcp_servers.toml` | `<workspace>/.mycli/mcp_servers.toml` | Repository server ids replace user ids |
| Plugins | `~/.mycli/plugins/<id>/` | `<workspace>/.mycli/plugins/<id>/` | User plugin ids replace repository ids; disabled wins |
| Skills | `~/.mycli/skills/` | `<workspace>/.agents/skills/`, then `<workspace>/.mycli/skills/` | Later sources replace earlier skill names |

Repository paths are excluded from discovery while workspace trust is `unknown` or `untrusted`.
This includes repository hooks, MCP servers, plugins, skills, plugin enablement in project
`config.toml`, and project execution rules. User-scoped integrations remain available. Granting
trust reloads repository sources before the decision is reported as successful. Revoking trust
removes their tools, hooks, commands, and resources and closes project MCP/plugin hosts before the
request completes; no restart is required.

Every parser bounds file size, item count, names, and diagnostic output. A malformed entry remains
visible as a diagnostic and does not prevent unrelated entries from loading.

## Tool Discovery And Session Reuse

Small allowed MCP/plugin catalogs (fewer than 100 tools and at most 128 KiB of serialized tool
schemas) are provided directly. Larger catalogs use `tool_search`, whose bounded source directory
includes configured MCP server instructions and plugin descriptions. Models can select relevant
capabilities from the task without the user explicitly naming the service. Resource tools remain
separate from executable tool discovery.

A successful search exposes up to 16 matching schemas on later provider steps. The successful
result also records bounded tool identities and definition fingerprints in SQLite. Later user
turns, including after reopening the session, can retain up to 64 discovered schemas within a
128 KiB budget. Retention requires an exact match against the currently allowed tool identity,
model name, and full definition. Older history without fingerprints does not grant retained
exposure; changed, removed, and disabled tools must be reconciled with the new catalog.

The active run freezes its directory and execution routes. Background refresh is adopted by a
later run. Search controls which schemas are sent to the model; membership in the frozen allowed
catalog, argument validation, approval, and hooks govern execution. A registered deferred tool
can be invoked without searching again merely because a new user turn started.

An unchanged exposed tool set keeps stable ordering and source descriptions across turns.
Successful discovery results also mark the exact history position where tools became available.
Mycli matches their fingerprints against the authorized request before passing load points to
pi-ai. Supported Responses routes emit schema-bearing `tool_search_call`/`tool_search_output`
or `additional_tools` history; supported Anthropic routes use `tool_reference` and deferred schemas.
Pi-ai owns compatibility detection and serialization. Other routes keep ordinary function schemas.
Search execution remains the local `tool_search` adapter; mycli does not rewrite provider wire
payloads or invent a second provider transport. Reopen, Worker transfer and retained compaction
history preserve load points. Removed or changed schemas cannot be loaded from stale history.
These rules preserve a stable prefix where the provider supports it; they do not promise cache hits.

## Management Commands

These commands work without a TTY and before backend/provider/TUI startup. OAuth login is the
exception: it needs an interactive terminal to show the authorization link.

```bash
mycli doctor
mycli doctor --json
mycli doctor --fix --json
mycli doctor --support-bundle --json
mycli sandbox status
mycli sandbox status --json
mycli sandbox setup
mycli sandbox setup --confirm --json
mycli sandbox reset
mycli sandbox reset --confirm --json
mycli sandbox repair
mycli sandbox repair --confirm --json
mycli sandbox uninstall
mycli sandbox uninstall --confirm --json
mycli hooks list --json
mycli hooks inspect <identity> --json
mycli hooks approve <identity>
mycli hooks revoke <identity>
mycli plugins list --json
mycli plugins inspect <plugin-id> --json
mycli plugins run <plugin-id> <command> --json-args '{"enabled":true}' --json
mycli mcp list --json
mycli mcp inspect <server-id> --json
mycli mcp add docs --url https://mcp.example.com/mcp
mycli mcp add files --cwd /path/to/workspace -- node /path/to/server.js
mycli mcp remove <server-id>
mycli mcp approvals --json
mycli mcp revoke <server-id>
mycli mcp login <server-id>
mycli mcp logout <server-id>
```

Human and JSON output are rendered from the same typed response. Management output omits hook
commands, environment values, plugin output, credentials, headers, and provider
payloads.

## Configured Hooks

Hooks use a JSON file with a bounded argv array or a shell command string. The argv form is easier
to audit and is preferred:

```json
{
  "hooks": [
    {
      "id": "check-write",
      "hook_point": "pre_tool_use",
      "command": ["node", "scripts/check-write.mjs"],
      "matcher": {"tool_name": "Write"},
      "timeout_seconds": 3,
      "working_directory": "workspace",
      "env_policy": "minimal",
      "enabled": true
    }
  ]
}
```

Supported points are `pre_tool_use`, `post_tool_use`, `user_prompt_submit`, `stop`,
`pre_compact`, `session_start`, and `session_end`. A configured hook does not run until its current
command digest is approved. Changing the command invalidates approval. `inherit_safe`, disabled
hooks, missing approval, and digest mismatch appear as doctor warnings; malformed configuration is
a failed check.

Hooks run through the normal sandbox/process-tree controller with a timeout of at most 30 seconds,
bounded stdin/stdout/stderr, and a selected safe environment. Diagnostics never contain command
arguments, hook payloads, output bodies, or environment values.

## MCP

MCP configuration supports `stdio`, `http`, and `streamable_http`. New remote integrations should
use Streamable HTTP.

```toml
[servers.files]
transport = "stdio"
command = "node"
args = ["dist/server.js"]
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled = true
required = false
enabled_tools = ["read_file", "search"]
disabled_tools = ["delete_file"]
default_tools_approval_mode = "auto"

[servers.files.sandbox]
mode = "workspace-write"
network = "enabled"

[servers.files.tools.read_file]
approval_mode = "approve"

[servers.catalog]
transport = "streamable_http"
url = "https://mcp.example.invalid/api"
bearer_token_env_var = "MCP_TOKEN"
startup_timeout_sec = 20
tool_timeout_sec = 60
default_tools_approval_mode = "prompt"
```

Environment placeholders resolve by name. Values are passed only to the MCP client and are never
returned by list, inspect, doctor, or runtime diagnostics. MCP tool ids use
`mcp:<server>:<tool>`. Model aliases are sanitized and collisions receive deterministic identity
suffixes; raw MCP names are preserved for protocol calls. MCP tools use the current approval
policy whether their schemas were provided directly or discovered.

`servers`, `mcp_servers`, and `mcpServers` are accepted root aliases. A URL without an explicit
transport selects Streamable HTTP. Legacy `timeout_ms` / `timeout_seconds` remain fallbacks for
both timeouts (30 seconds if absent). `startup_timeout_sec` bounds connection establishment and
each discovery operation separately; `tool_timeout_sec` bounds a tool invocation or resource read.
Both accept positive values up to 300 seconds. They are not a combined total startup budget.

`cwd` resolves relative to the workspace for direct configurations and the plugin installation
for bundled definitions. A different working directory does not grant write access there.
`env_vars` inherits named environment variables; explicit `env` entries override them. `headers`
and `http_headers` accept literal values or `${ENV_NAME}` references, `env_http_headers` maps header
names to environment variable names, and `bearer_token_env_var` sets Authorization. Missing referenced
variables are reported as configuration errors. Management output never prints their values.

`enabled_tools` is an allowlist of **raw MCP tool names**; an absent list permits all tools and an
empty list permits none. `disabled_tools` takes precedence. Filters apply to cached and live
catalogs before routing or model exposure. Standard annotation hints are retained; a read-only
hint permits parallel scheduling but does not authorize execution.

An enabled `required = true` server must complete live discovery before runtime readiness; cached
tool metadata is insufficient. Startup or tools-list failure blocks readiness and closes started
clients. Individual incompatible tools and optional resource failures remain isolated. Optional
servers retain background discovery and do not hold up startup. The same settings apply to MCP
servers contributed by enabled plugins.

### OAuth Authentication

For a Streamable HTTP server that requires OAuth:

```bash
mycli mcp add service --url https://mcp.example.com/mcp
mycli mcp login service
# Open the displayed authorization link, then return to the terminal.
mycli mcp logout service
```

The same commands support MCP servers from enabled plugins. Use the `plugin-id/server-name`
selector displayed by `mycli mcp list` and `/mcp`, for example `mycli mcp login my-plugin/docs`
or `mycli mcp login my-plugin@personal/docs`. Internal server IDs remain accepted. Login/logout
resolve the same effective configuration as runtime discovery, without starting plugin workers,
hooks, models, or unrelated MCP clients. Disabled plugins and untrusted repository plugins do not
contribute servers. Explicit standalone MCP configuration takes precedence for an identical
internal server ID.

Login uses the MCP SDK's protected-resource/authorization-server discovery, dynamic client
registration, authorization code and PKCE flow. The callback listens only on `127.0.0.1`, validates
state, and closes on completion, cancellation or a five-minute deadline. Mycli does not open a
browser automatically. Auth requests obey the server's configured and managed network limits;
HTTP is allowed only for loopback development endpoints, and redirects are rejected.

Optional settings in `mcp_servers.toml` support pre-registered public clients and fixed callbacks:

```toml
[servers.service.oauth]
client_id = "my-public-client" # omit to use dynamic registration
scopes = ["read", "write"]
callback_port = 8765 # omit for an automatically allocated loopback port
```

Credentials use private files under `~/.mycli/mcp-auth/` (directory `0700`, files `0600` on Unix),
isolated by server/source, endpoint, configured headers and OAuth settings. This is private file
storage, not OS keychain storage. Codes, state and PKCE verifiers are kept only for the active login.
Runtime requests read saved tokens and serialize refresh across processes, preserving rotated
refresh tokens. Refresh never opens a browser. Missing/expired authorization directs the user to
`mycli mcp login <server-id>`. After login, open `/mcp` while idle or start the next turn to refresh
discovery. Refresh waits while any shared run remains active or suspended. Logout removes
the active configuration's saved credentials and takes effect on subsequent requests. It does not
revoke tokens at the remote authorization server or reverse requests already in flight.

Configured `Authorization` headers and `bearer_token_env_var` remain independent of OAuth and take
precedence. OAuth login rejects such configurations rather than silently replacing their identity.
Legacy standalone `http` and stdio do not use this OAuth flow. Codex bundles normalize `type: "http"`
to Streamable HTTP and accept OAuth `clientId` / `callbackPort` aliases, with canonical `client_id`
/ `callback_port` taking precedence. Keeping a per-server callback port is a mycli extension;
the inspected Codex source uses its global callback setting.

Plugin credentials are also bound to the plugin ID, source and declared server name. Updating an
immutable package snapshot preserves the login when the endpoint, headers and OAuth settings
remain unchanged. Changed identities do not inherit credentials. Tool approvals include the
package/configuration and tool definition fingerprints, so a package update still requires a new
approval where applicable. `mcp list` reports `oauth`, `configured_header`, `not_logged_in`,
`unsupported` or `unavailable`; `not_logged_in` only means there are no saved OAuth credentials,
not that the server necessarily requires authentication.

### Server-Initiated Questions (Elicitation)

During a tool call, an MCP server can request a form or ask the user to visit an HTTPS URL. The TUI
shows the server identity and message, presents form fields one at a time, and requires an explicit
final submission. It supports strings, numbers, booleans, single choices and multiple choices,
including titled enums and optional/default values. Answers are validated against the original
MCP schema without type coercion. An invalid answer keeps the request pending for correction.
Escape cancels the request; Decline rejects it. URL mode displays the link and a Continue action;
the client neither opens it automatically nor treats confirmation as a completed server-side login.

Requests use the existing visible interaction queue alongside tool approvals. The owning MCP call
continues after the answer without a new model call or a durable turn suspension. Time spent waiting
for input is excluded from the service execution deadline; each prompt has a five-minute limit.
Full Access does not answer forms or confirm URLs. Mycli does not persist form answers or URL
requests in the conversation or publish answers in gateway notifications. A server may independently
include information in its later tool result, which follows normal tool-output persistence.

Responders are live and bound to server, connection generation, session and turn. Cancellation,
completion of their owning calls, connection close or UI shutdown cancels pending requests. Session
resume cannot resurrect them. Headless requests without an interactive consumer cancel immediately.
The shared connection admits elicitation only when active calls have one unambiguous session/turn
owner; unsolicited startup/resource requests and ambiguous concurrent owners cancel instead of
guessing which conversation should answer. Sampling and task-augmented elicitation are not supported.

### MCP Process And Network Permissions

Stdio servers run as ordinary local subprocesses with the current user's filesystem and network
access by default, matching Codex's local MCP launch behavior. This lets servers such as Playwright
use their browser profiles, caches, and system services without first changing the Shell permission
preset. The browser's own sandbox is controlled by the browser/server configuration.

These long-lived processes use a policy resolved at integration startup, capped by managed
execution-policy bounds. They do not inherit temporary Shell grants or changes to the turn's
permission selector. Tool approvals, hook permissions, and Plugin API v2 capability declarations
remain separate. Per-server `[servers.<id>.sandbox]` can set `mode = "workspace-write"` or
`mode = "read-only"`, and/or `network = "disabled"`. These restrictions use the platform sandbox
and fail closed if enforcement is unavailable. A configured `cwd` does not add writable roots to
a restricted profile. Read-only controls filesystem writes; networking is an independent setting.

Domain-restricted stdio networking uses the existing owned proxy on macOS. Linux and Windows reject
a nonempty enabled domain restriction before starting the process because the proxy enforcement is
not implemented there. An empty domain list runs offline. Arbitrary managed read-root restrictions
also fail before process launch: current process sandbox backends cannot enforce them. See
[network policy](network-policy.md) for proxy traffic and platform limits.

Both HTTP transports check disabled/domain network bounds before each request. Configured loopback
endpoints are permitted when networking is unrestricted. Redirects are rejected, so a different
endpoint cannot receive authorization headers, session IDs, or tool arguments; configure the final
MCP URL directly.

### Tool Approval

Tool-level `[servers.<id>.tools.<raw-tool>].approval_mode` overrides
`default_tools_approval_mode`:

| Mode | Behavior |
| --- | --- |
| `auto` (default) | Ask under normal permissions; Full Access or an existing tool grant allows execution |
| `prompt` | Ask even in Full Access unless an explicit session/remembered grant matches |
| `approve` | Configuration explicitly authorizes that tool |

Interactive MCP approvals offer Approve once, Reject, Allow for session, and Always allow.
Session grants last for that runtime session. Remembered grants survive restarts in the private
`~/.mycli/integration-tool-approvals.json` file. Each grant binds an integration ID to a hash of the
server configuration (including the effective stdio working directory), tool definition, and
annotation hints; changes require a new approval.
The file contains identities and hashes, never endpoint credentials or arguments. Grants do not
create Shell execution rules. Resumed approvals validate their saved scope before execution;
storage errors cannot silently grant permission or start the tool.

Use `mycli mcp approvals` to inspect remembered tool IDs and `mycli mcp revoke <server-id>` to
remove that server's remembered grants. Revocation is observed on subsequent invocations in an
already running session. It does not remove separate session grants or cancel an already approved
invocation. Restart that session to clear its session grants. Explicit `approve` configuration
continues to authorize tools until the configuration is changed.

`mcp add` and `mcp remove` update **user configuration only** using a private atomic writer. Add
rejects an existing user ID, and edits preserve unrelated TOML values (comments may be reformatted).
They validate without starting clients and report active repository overrides. Configuration changes
apply before the next idle turn or catalog inspection. Removal leaves remembered grants intact; revoke them separately
when desired. Use `mycli mcp add --help` for environment, timeout, filter, approval, and sandbox flags.
The `--` separator preserves the server's arguments, including its own `--json` flag.

`mcp list`, `mcp inspect`, and doctor may connect to enabled servers to verify discovery. They use
the same timeout, sandbox, cancellation, and cleanup path as runtime startup and close every client
before returning.

Tool schemas are checked before entering the usable catalog. Standard JSON Schema formats such
as `uri`, `date-time`, and `uuid` are validated on invocation. An incompatible tool is isolated with
`schema_error`; healthy sibling tools remain available. Tool and resource discovery fail
independently. A server with usable capabilities and discovery failures reports `partial`, with
scoped details. Local policy blocks remain distinct from a user rejecting approval.

Discovery follows native pagination with cursor-cycle checks, a 100-page limit, a 10,000-item limit,
and an 8 MiB aggregate bound. Repeated refreshes query the live client again; concurrent callers
share pending discovery and one caller's cancellation does not cancel other waiters. The manager
owns one client per configured server, reused by cached and refreshed registrations.

Canceling or timing out a local stdio call retires its process generation. A process that exits
independently immediately releases its proxy and can reconnect on a later explicit call. A later explicit call
starts a fresh connection. The canceled/timed-out operation is never automatically replayed;
sibling calls affected by process retirement report a connection failure with an unknown outcome.
Closing the manager permanently stops discovery and closes its owned clients.

MCP tool and resource failures include bounded diagnostics: operation, connection/request phase,
HTTP status, JSON-RPC code, and an allowlisted transport cause code when available. Version-1 error
contexts preserve this evidence in tool results and session history. Endpoint URLs, session IDs,
authorization headers, and raw upstream error bodies are never included in those diagnostics.

For Streamable HTTP, a POST rejected with HTTP 404 while carrying an MCP session ID triggers a
fresh initialization and at most one retry of the rejected operation. ModelScope's HTTP 401 with
the exact JSON code `SessionExpired` receives the same recovery when a session ID was sent;
ordinary HTTP 401 authentication failures do not trigger session reinitialization. A saved OAuth
identity may refresh and retry one explicitly rejected 401 request; this is separate from session
recovery. Concurrent failures share
the replacement connection; already running requests can finish on the old connection. Cancellation
or client close stops further recovery work. A 404 without a session ID, ordinary HTTP errors,
timeouts, and ambiguous disconnections do not replay tool calls automatically. When execution
cannot be confirmed, the error records an unknown outcome so callers can check remote state before
retrying an operation that may have side effects. An unsupported optional GET stream (HTTP 405)
remains compatible with POST-based MCP servers.

## Images And MCP Resources

`view_image` accepts a local `path`. It decodes PNG, JPEG, GIF and WebP by their actual content,
checks the current file-read permissions, and scales large images to fit within 2048 x 2048.
When the selected model supports original image detail, the schema also exposes
`detail: "high" | "original"`; `original` retains the source dimensions. The tool does not crop,
render SVG, run OCR, or call Quick Look. Image bytes and detail survive session recovery.
Input/output files are bounded to 10 MB and decoding to 64 million pixels.
Image decoding requires the platform binaries installed with npm optional dependencies. These load
only when viewing an image; installations without them can still start and use other tools.

`list_mcp_resources` and `list_mcp_resource_templates` accept optional `server` and `cursor`.
Omitting `server` aggregates configured servers; a server-specific request returns one native MCP
page. Send its `nextCursor` back as `cursor` with the same server. Templates return `uriTemplate`
values such as `data:///notes/{name}`. Instantiate that template and pass the resulting URI to
`read_mcp_resource({server, uri})`. These tools do not require MCP tool activation.

Resource results remain bounded JSON and explicitly mark truncation. Image resources are attached
as images rather than base64 text. Previously persisted `offset` calls still execute through a
dispatch-only compatibility schema; new provider requests use the Codex-style parameters.

See [the Codex comparison](parity/2026-09-09-image-resource-tools.md) for scope and differences.

## Skills

A skill is either `<root>/<name>.md` or `<root>/<name>/SKILL.md` with TOML or YAML frontmatter:

```markdown
---
name: repository-review
description: Review repository changes for correctness and risk.
trigger_hints: [review, regression]
workspace_dependencies: [.git]
guardrails: [Do not modify files.]
---

Inspect the requested change and report findings before summaries.
```

The default provider schema contains one stable `Skill` tool. Individual skill files do not add
provider tools. A successful invocation appends bounded, fenced instructions to the durable
transcript. Management/doctor output exposes counts and issue categories, never the skill body.

## Subagents

Subagents are prompt-driven. The parent supplies `task_name`, `message`, and optional `fork_turns`;
there are no profile files or profile-specific prompts, models, tools, or budgets. The child inherits
the parent's resolved provider/model, execution policy, and exposed tools. Runtime budgets remain
optional, and omitting them does not introduce a hidden turn or tool-call ceiling.

Every child is an independent durable Node thread with immutable identity, canonical path, frozen
least-authority execution policy, provider state, queue, cancellation boundary, and session
artifacts. Parent ownership gates routing, interruption, recovery, and shutdown cleanup.

The provider-visible coordination tools are `spawn_agent`, `send_message`, `followup_task`,
`wait_agent`, `interrupt_agent`, and `list_agents`. `spawn_agent` is the only child-spawn entry
point. `Task`, legacy `SendMessage`, and `SubagentOutput` routes are not registered or exported.

Terminal reports enter the durable parent mailbox automatically and idempotently. Each child also
owns `session.json`, `events.jsonl`, task output, subagent projections, transcript state, and usage
projection beneath its own session identity. Parent task/subagent files remain readable indexes;
SQLite is authoritative and repairs derivable files. Provider-only mailbox payloads are never
rendered as user-authored transcript rows.

Use `wait_agent` only when the caller has no independent work left. It subscribes to mailbox,
lifecycle, user-steering, cancellation, and timeout activity without polling or creating a process.
`WriteStdin` remains solely the transport for an existing persistent Shell session. The complete
agent configuration, permission, artifact, recovery, and TUI contract is documented in
[node-agent-runtime.md](node-agent-runtime.md).

## Plugins

Plugins may be Codex-style bundles installed with `mycli plugins add <directory|Git-source|name@marketplace>`.
Bundles contribute namespaced skills, MCP servers and command hooks through the existing runtime
systems. Use `mycli plugins marketplace add <source>` to register a catalog, then
`mycli plugins list --available` to browse it. Install/update/enable/disable/remove take effect before
the next turn or idle catalog inspection; installation does not execute package code. Existing
active or suspended runs keep that session's previous tools, skills, hooks and connections until
its owners finish. Other sessions refresh independently, including a parent with a waiting child. New configuration discovery completes before the next run captures its catalog. An unchanged
configuration reuses its connections. Required-server or composition failure retains the previous
content and rejects the refresh; correct the configuration and retry. Apps declarations are reported as
unavailable. See [plugin-codex-parity.md](plugin-codex-parity.md) for formats, commands and limits.

Executable ESM plugins use the process-isolated Plugin API v2. Production entries must be compiled `.js` or
`.mjs`; raw TypeScript and Python source are not executed. See [plugin-api-v2.md](plugin-api-v2.md)
for the author contract and [migration/python-plugins-to-v2.md](migration/python-plugins-to-v2.md)
for Python migration.

Plugin tools use stable ids `plugin:<plugin-id>:<tool-name>` and share the direct/deferred exposure,
identity normalization, and catalog publication rules above. They retain their approval policy. Plugin commands are provider-free. Plugin hooks join
the normal ordered hook pipeline. The worker receives only a minimal environment plus explicitly
declared names, and every invocation is bounded by protocol size, timeout, outstanding-request, and
output limits.

`/plugins` reflects live process status: a crashed worker becomes `error`, a replacement is
`loading`, and a successfully initialized worker becomes enabled again. Successful calls do not
refresh the extension catalog. A retired or closed runtime cannot publish old plugin state.

Failures identify the plugin, operation, phase, and safe process evidence such as exit code or
timeout. The runtime may start one replacement for a new invocation after a crash, timeout, or
cancellation. Concurrent callers share startup; cancelled callers are not dispatched. Calls with
uncertain outcomes are never replayed automatically. Registration changes or protocol corruption
require a runtime reload after correcting the plugin. Commands remain provider-free through
`mycli plugins run` and the registered `/plugin:<id>:<command>` routes.

See [plugin-codex-parity.md](plugin-codex-parity.md) for the Codex comparison and compatibility scope.

## Doctor And Troubleshooting

`mycli doctor` runs collectors independently and sequentially. One exception becomes one failed
check and later collectors still run. Warnings exit `0`; any failed check exits `1`.

`mycli doctor --fix` previews deterministic repairs without mutation. Applying requires the exact
displayed plan id through `--confirm <plan-id>`; the current repair delegates canonical user-config
migration to the configuration owner. `--support-bundle` writes one private allowlisted JSON report
without raw logs, extension payloads, commands, credentials, provider data, or automatic upload.

The report covers config/auth presence, read-only SQLite/storage, logs/traces/redaction, package and
gateway contracts, the built-in tool manifest, sandbox/process support, every extension source, and
Python-plugin migration state. It never calls a model provider. SQLite opens read-only and doctor
does not create, migrate, repair, delete, or vacuum local state.

`mycli sandbox status [--json]` runs the same side-effect-free sandbox readiness classifier without
loading extensions, starting the interactive backend/TUI, calling a provider, requesting elevation,
or running setup. `sandbox setup`, `reset`, `repair`, and `uninstall` return a typed preview by default and require
`--confirm` before any state change. Their response includes the required privilege, bounded effects,
result code, and post-operation readiness. Windows setup may request UAC; reset cleans recorded ACLs
and local setup state while retaining accounts and network rules. Repair stops sandbox processes and
rebuilds setup; uninstall also removes owned accounts and network rules. See [Windows maintenance](windows.md).
macOS/Linux missing dependencies remain manual recovery steps. Raw helper
output and paths never enter any response.

Common remediation:

- `config=failed`: fix TOML syntax or provider/protocol compatibility, then rerun doctor.
- `sessions_db=failed`: preserve the file and inspect schema/recovery diagnostics; doctor will not
  repair it.
- `process_sandbox=failed`: run `mycli sandbox status` for the stable readiness code and remediation,
  then install or repair the platform prerequisite documented in
  [node-runtime-rollout.md](node-runtime-rollout.md).
- `hooks=warning`: inspect and approve the current hook identity/digest.
- `plugins=failed`: build the declared ESM entry and verify manifest declarations match runtime
  registrations.
- `plugin_migration=warning`: migrate Python plugins; Node never imports them.
- `mcp=failed`: verify transport availability and referenced environment names, without putting
  credential values in configuration or command output.


Skills and hooks can also be managed interactively with `/skills` and `/hooks`. User enablement
overrides are stored in `~/.mycli/integration-enablement.json`, keyed to each capability's source
identity. Hook command trust remains in `~/.mycli/hook-allowlist.json`. Changing availability does
not grant command trust. File/catalog changes and trust changes apply to subsequent turns; an active
run keeps its captured definitions and approvals. Plugin hooks retain their plugin authority.
