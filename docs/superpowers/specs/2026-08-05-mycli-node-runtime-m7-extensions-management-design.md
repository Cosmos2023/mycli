# mycli Node Runtime M7 Extensions And Management Design

Date: 2026-08-05
Status: Approved

## Summary

M7 ports every remaining supported production capability needed before Python retirement:
Anthropic Messages, skills, MCP, configured command hooks, process-isolated Plugin API v2,
subagents, setup, management commands, doctor, and extension migration diagnostics.

M7 remains one milestone delivered as eight ordered vertical slices. Each slice has an independent
quality gate, while the milestone closes only after the compiled Node CLI passes the complete
parity and no-Python smoke gate. The Python sidecar remains an explicit startup-level rollback
choice until M8; a Node turn never falls back to Python after it starts.

## Goals

- Run Anthropic text, reasoning, image, and tool turns through the existing Node agent loop.
- Restore supported skills, MCP, hooks, plugins, and subagents without changing the stable built-in
  tool schema accidentally.
- Preserve supported user/repository configuration, management commands, setup behavior, durable
  state, TUI events, and bounded diagnostics.
- Isolate untrusted extensions and external commands with validation, sandboxing, timeouts, output
  limits, cancellation, redaction, and process-tree cleanup.
- Keep package dependencies acyclic and keep provider/SDK/process details out of core contracts.
- Leave M8 with removal work, not missing runtime capabilities or unresolved extension design.

## Non-goals

- Removing the Python implementation or making Node the only backend. That is M8.
- Source-compatible execution or automatic translation of Python plugins.
- Running raw TypeScript plugin source in production through `tsx` or another source loader.
- Adding a hosted marketplace, OAuth productization, or unrelated new integrations.
- Redesigning the existing TUI.
- Adding fixed global provider-step or tool-call limits. Subagent budgets apply only when a profile
  explicitly configures them.
- Translating the 4,436-line Python doctor service or any other Python module line by line.

## Delivery Decision

The alternatives were separate capability milestones and one compatibility-first bulk port.
Separate milestones would fragment the approved M7/M8 roadmap. A bulk port would delay feedback on
package cycles, tool-schema stability, and process isolation until late integration.

M7 therefore uses ordered vertical slices:

1. Anthropic provider.
2. integrations foundation.
3. skills.
4. MCP.
5. configured hooks.
6. Plugin API v2.
7. subagents.
8. setup, management, doctor, migration documentation, and final gates.

Each slice must build, typecheck, lint, and pass focused tests before the next slice starts.

## Package Architecture

```text
@cosmos2023/app
  |-- @mycli/providers
  |-- @mycli/runtime
  `-- @mycli/integrations
        |-- skills
        |-- mcp
        |-- hooks
        |-- plugins
        `-- subagents

@mycli/runtime and @mycli/integrations
  `-- shared neutral contracts from @mycli/core / @mycli/tools
```

Ownership is fixed as follows:

| Package | M7 ownership |
| --- | --- |
| `@mycli/contracts` | Plugin API v2 JSON Schemas, generated types, gateway payload schemas |
| `@mycli/core` | Side-effect-free provider, hook, context-item, and child-task value types |
| `@mycli/config` | Compatible extension config readers and atomic config/auth writers |
| `@mycli/providers` | Anthropic adapter, SDK facade, and provider failure mapping |
| `@mycli/tools` | Generic registration/routing, approval, sandbox, and process facilities |
| `@mycli/storage` | Additive durable child-task and replay metadata storage |
| `@mycli/integrations` | Skills, MCP, hooks, plugin host, subagent control plane, management data |
| `@mycli/runtime` | Hook ordering, instruction injection, tool-loop and child-runtime-neutral hooks |
| `@cosmos2023/app` | Composition, utility CLI routing, setup, doctor, shutdown, and output rendering |

`@mycli/runtime` does not import `@mycli/integrations`. The application creates integrations and
injects generic tool registrations, a neutral ordered hook runner, and a child runtime factory.
Subagents use an application-provided `ChildRuntimeFactory`; integrations does not construct or
fork a separate agent-loop implementation.

The initial external dependencies are `@anthropic-ai/sdk` in providers and
`@modelcontextprotocol/sdk` in integrations. The lockfile pins resolved versions. Third-party types
do not appear in core, runtime, or application public interfaces.

## Canonical Runtime Additions

M7 needs two additive canonical concepts that the current text/tool-only history does not express.

### Durable context items

A durable context item contains bounded text plus metadata such as:

- `kind=skill_instructions`
- `cache_class=dynamic`
- `durability=persistent`
- `scope=transcript`
- skill name, source kind, body digest, and content length

Provider projection maps it to protocol-appropriate system/developer context. It is fenced as a
loaded reference and cannot be mistaken for the current user request. Storage writes it as an
additive history item that older Python readers can safely ignore or render as reference context.

### Opaque provider replay state

Anthropic signed thinking blocks must be replayed exactly during later tool steps. Provider events
therefore gain a bounded opaque replay-state event/item. Runtime stores it with the assistant item
but does not inspect provider-specific fields. Only the originating provider adapter consumes it.

The Anthropic adapter accepts only the minimum replay fields needed by the Messages API, including
thinking text/signature data. Replay state is size-bounded, schema-checked at the adapter boundary,
excluded from human diagnostics, and invalidated when history is compacted incompatibly.

All SQLite changes remain additive while Python and Node coexist. Cross-backend fixtures prove
that both sides can read records written by the other side.

## Anthropic Messages Provider

`AnthropicProvider` implements the existing `ModelProvider.stream()` contract. It does not create a
second runtime loop.

The adapter owns:

- separating system/developer instructions from message history;
- protocol-valid user/assistant alternation and adjacent tool-result grouping;
- text, image, tool-use, tool-result, and signed thinking serialization;
- stable unique provider tool-use ids and result correlation;
- provider tool schema projection;
- at most four explicit Anthropic cache-control breakpoints;
- incremental text, thinking, tool-input, usage, stop, and replay-state projection;
- status, connection, validation, and cancellation error classification.

The SDK is hidden behind an injectable facade. SDK retries are configured to zero because the Node
runtime owns retry decisions and emits retry lifecycle events. The registry adds `anthropic` and
`anthropic_messages` to provider/profile validation with Anthropic defaults and compatible auth
references.

Anthropic does not use Responses continuation ids. Every tool step is serialized from canonical
history plus valid replay state. Compaction or corrupt replay metadata clears provider continuation
state and causes a full canonical replay or a stable provider-protocol failure, never a hidden
fallback.

## Integrations Foundation

`@mycli/integrations` is one package with capability-specific directories and narrow public
exports. Shared foundation types cover:

- source scope and deterministic user/repository precedence;
- bounded diagnostic issues and safe management rows;
- close-once lifecycle handles;
- generic tool registrations and origin metadata;
- timeout/cancellation helpers around host-owned process facilities;
- stable extension ids and provider-safe route names.

It reuses `@mycli/tools` sandbox and process-tree facilities. It does not introduce a second shell,
approval implementation, or environment policy.

The application builds integrations before the first turn, projects registrations into the tool
router, and closes them in reverse construction order on session/backend shutdown.

## Skills

The registry discovers these sources in increasing precedence order:

1. builtin skills;
2. user skills under `~/.mycli/skills`;
3. shared repository skills under `.agents/skills`;
4. repository skills under `.mycli/skills`.

It accepts root `*.md` and nested `*/SKILL.md` files, parses TOML or YAML frontmatter, and requires
non-empty `name` and `description`. Trigger hints, environment/workspace dependency hints,
guardrails, source kind, and body are retained. A malformed or duplicate definition produces a
bounded diagnostic while unrelated skills remain available.

The default provider-visible schema contains exactly one stable `Skill` tool. A bounded catalog of
skill names and descriptions is placed in model context. Invocation validates the selected name,
loads the current winning definition, and returns a durable context-item artifact. Runtime commits
the tool result and context item atomically before the next provider step.

Adding or removing a skill does not add or remove provider tool definitions. Legacy per-skill
contribution ids remain diagnostics-only compatibility data.

## MCP

MCP uses the official TypeScript SDK for the high-level client and supported transports:

- stdio for local process integrations;
- Streamable HTTP as the preferred remote transport;
- the existing Python-compatible remote HTTP mode through a bounded compatibility adapter where
  the SDK transport cannot represent that configuration directly.

Configuration remains compatible at `~/.mycli/mcp_servers.toml` and
`<workspace>/.mycli/mcp_servers.toml`, with repository entries overriding same-named user entries.
The existing `servers`, `mcp_servers`, and `mcpServers` table aliases and the `stdio`, `http`, and
`streamable_http` transport names remain accepted.

Each configured server receives a lifecycle object that initializes once, exposes tools/resources,
propagates abort signals, and closes once. Stdio startup runs through the existing sandbox,
minimal/safe environment, process group, and process-tree cleanup facilities. Remote configuration
validates URL and headers but never includes header values in diagnostics.

Tool discovery validates and normalizes JSON Schema before exposure. Stable manifest ids are
`mcp:<server>:<tool>` and provider routes are provider-safe encoded names. MCP additions appear in
the combined extension manifest with `source=mcp` and `toolset=external`; they do not mutate the
built-in manifest.

Tool results retain text, structured content, image content, and `is_error`, subject to per-item and
aggregate bounds. Interruption cancels the active SDK request and closes a stdio transport when the
transport cannot safely continue.

`mcp list|inspect` is provider-free. Discovery and doctor may initialize configured servers to
count tools, matching current behavior, but they never start a model request. Output is limited to
server id, transport, enabled/status, tool count, timeout, and stable failure category.

## Configured Command Hooks

The registry preserves user/repository `.mycli/hooks.json`, flat hook entries, and supported
Codex-style event groups. It supports:

- `pre_tool_use`
- `post_tool_use`
- `user_prompt_submit`
- `stop`
- `pre_compact`
- `session_start`
- `session_end`

Runtime owns the exact point and ordering at which hooks fire. Integrations owns discovery,
matching, allowlist checks, process execution, and safe result normalization.

Configured hooks remain language-neutral external commands. Each registration validates the
command form, source path, working directory, safe environment policy, matcher, enabled flag, and a
timeout greater than zero and no more than 30 seconds. Approval binds source scope, identity,
canonical command digest, and config path. Any material command change invalidates approval.

The process receives a versioned bounded JSON request on stdin. The preferred stdout result is one
bounded JSON object with action `allow`, `deny`, `modify`, or `error`. Compatibility remains for
the current Codex-style decision fields, exit code `2` blocking behavior at blocking hook points,
and plain-text additional context at the currently supported context-producing hook points. Stderr
is diagnostic-only and bounded. Unsupported or ambiguous output fails with `error`.

Pre-tool validation, allowlist, sandbox, timeout, or protocol failure prevents the tool from
executing. Post-operation hook failures are recorded but cannot rewrite or roll back a completed
side effect. Built-in permission hooks run before configured/plugin pre-tool hooks so an extension
cannot weaken host policy.

`hooks list|inspect|approve|revoke` returns typed management results with matching human and JSON
renderers.

## Plugin API v2

Plugin API v2 replaces Python module loading. The manifest remains named `plugin.yaml`. Repository
plugins live under
`<workspace>/.mycli/plugins/<id>` and user plugins under `<home>/.mycli/plugins/<id>`. User source
wins duplicate ids; disabled wins enablement conflicts.

### Manifest

The versioned manifest contains at least:

- `api_version: 2`;
- stable `id` and `name`, plus optional version and description;
- a relative compiled ESM `entry` that remains inside the plugin directory;
- declared tools, hooks, commands, required environment names, and requested capabilities.

The host rejects unsupported versions, path escapes, raw `.ts`, Python entries, missing files,
duplicate registrations, undeclared registrations, and invalid schemas. Python plugin directories
are surfaced as `migration_required` diagnostics and are never imported or executed.

### Process isolation

The host launches a package-owned worker bootstrap in a separate Node child process and passes the
validated plugin entry as data. The plugin never receives host registry objects or imports private
mycli modules.

Communication is newline-delimited JSON. Every message carries protocol version, message type, and
request id where applicable. Host requests are `initialize`, `invoke`, and `shutdown`. Worker
responses are `registered`, `result`, `error`, and `shutdown_complete`. Invocation targets are
explicit tool, hook, or command handler tokens returned during initialization.

Draft 2020-12 schemas live in `@mycli/contracts`; both host and worker validate every incoming
message. The host enforces maximum line/message/output sizes, a bounded number of outstanding
requests, initialization and call timeouts, cancellation, immutable registrations after
initialization, minimal environment, sandboxing, and bounded shutdown.

A crash or protocol violation fails only that plugin's pending requests, marks it unavailable, and
cleans up its process tree. Tool, hook, and command errors become structured failure results rather
than uncaught host exceptions.

Stable manifest ids are `plugin:<plugin>:<name>`. `plugins list|inspect|run` is provider-free, and
in-session plugin commands use the same command registry without model invocation.

## Subagents

Profile discovery preserves builtin, user, and repository precedence, enablement, system prompt,
description, model override, allowed tools, denied tools, and optional budgets. Tool scope is frozen
when a child starts and can only narrow the parent's currently authorized tool set.

`SubagentController` receives an injected `ChildRuntimeFactory`. A child runtime uses:

- a stable child session id and explicit parent session/turn ownership;
- the same `NodeTurnRuntime` implementation as the parent;
- a child-specific transcript seed and frozen tool router;
- an optional model override;
- its own abort signal and bounded event sink.

Foreground invocation waits for the terminal result. Background invocation persists a task record,
returns its task id immediately, and emits bounded progress and terminal notifications through the
existing TUI event surface. The controller supports recent runs, task inspection, output reading,
messaging, interruption, result collection, and shutdown.

Parent shutdown aborts owned children and waits for bounded cleanup. On restart, abandoned running
records become explicitly interrupted unless a supported durable checkpoint proves they can be
resumed without replaying side effects. No implicit global 8-step/16-tool limit is added. Explicit
profile budgets and existing cancellation/no-progress protections remain available.

## Setup And Management Commands

The Node CLI detects utility commands before TTY validation, provider construction, or runtime
startup:

- `setup`
- `doctor`
- `hooks list|inspect|approve|revoke`
- `plugins list|inspect|run`
- `mcp list|inspect`
- `subagents list|inspect`

Each service returns a typed JSON-serializable result. Human renderers consume the same object;
`--json` never scrapes human output. Invalid usage and failed operations return nonzero exit codes.

Setup reuses the existing Node setup TUI and adds a plain terminal fallback. Node constructs
provider state, writes compatible TOML atomically, writes API keys to the existing auth store
atomically with mode `0600`, preserves unrelated supported configuration, and never echoes a key.

## Doctor

Doctor is a collection of independent bounded collectors with stable names and
`ok|warning|failed` status. A collector failure produces one failed check and does not abort later
checks.

The M7 Node doctor covers:

- config, auth presence, provider/profile validity, and storage layout;
- SQLite integrity, required/additive schema, recovery state, and session continuity;
- logs/traces, redaction, context, retry, interruption, tool lifecycle, and shell state;
- contract and generated-type drift;
- built-in and combined extension tool manifests;
- sandbox/process dependencies and Node/package compatibility;
- hooks, plugins, skills, subagents, MCP, and Python-plugin migration state;
- TUI/runtime protocol compatibility.

Doctor does not call a model provider. It may initialize configured local/remote MCP servers and
plugin workers where the corresponding health check requires discovery, matching current behavior.
Those checks use normal sandbox, timeout, redaction, and cleanup paths.

Human and JSON output never includes credentials, provider payloads, headers, hook/plugin command
arguments, environment values, raw extension output, prompts, tool arguments, or private file
contents.

## Runtime Data Flow

```text
Node backend startup
  -> load config/auth and durable session state
  -> discover and validate extensions
  -> start approved/lazy integration lifecycles
  -> compose built-in and contributed tool routes
  -> publish bounded extension/resource manifests

turn submit
  -> reserve durable turn
  -> freeze trust, permission, tool, hook, and child-task policy
  -> run user_prompt_submit hooks
  -> project canonical history and skill context
  -> stream one configured provider through ModelProvider
  -> normalize provider events
  -> for each tool batch:
       run pre_tool_use hooks
       execute built-in / Skill / MCP / plugin / subagent route
       persist result and durable context/task changes
       run post_tool_use hooks
       continue through the same provider/runtime
  -> run stop hooks
  -> persist terminal turn and emit terminal TUI events
```

Backend/session shutdown closes child tasks, plugins, MCP transports, and other integration handles
in reverse construction order. All close operations are idempotent and bounded.

## Failure And Security Rules

- Extension config failures are local to the affected entry; unrelated entries continue loading.
- Tool and hook schemas are validated before provider exposure and again at the untrusted boundary.
- Provider-returned calls to unexposed tools fail before persistence or execution.
- Pre-operation hook failures fail closed; post-operation failures cannot falsify completed work.
- Local extension processes inherit only the selected safe environment plus explicitly approved
  values. Environment variable names may be diagnostic-visible; values are not.
- Timeouts and interrupts propagate through SDK requests, child processes, and child runtimes.
- Process cleanup uses platform-specific process-tree facilities already proven by M6.
- Raw provider, MCP, plugin, and hook data is never placed in standard diagnostics.
- Node accepts a turn only after backend selection. A Node failure remains a Node failure.

## Testing Strategy

### Unit tests

- Anthropic request serialization, cache breakpoints, replay state, stream events, stop reasons, and
  error classification.
- Source precedence, manifest/config parsing, stable ids, schema validation, output bounds, and
  diagnostic redaction for every integration.
- Hook ordering, digest invalidation, matcher behavior, pre/post failure policy, and result mapping.
- Plugin host/worker protocol state machine, message bounds, timeout, crash, and cancellation.
- Subagent profile/tool scope, task state machine, recovery, budgets, and no-progress behavior.
- Setup writes, management parsing/rendering, doctor status aggregation, and JSON stability.

### Integration tests

- Real local MCP stdio server plus Streamable HTTP fixture.
- Real compiled ESM plugin worker registering a tool, hook, and command.
- Real configured hook command covering approve, digest change, timeout, malformed output, and
  sandbox failure.
- Foreground/background child runtimes with SQLite state, progress, interruption, restart recovery,
  and shutdown cleanup.
- Compiled CLI utility routing before TTY/provider startup.

### Parity and platform tests

- Python/Node fixtures for retained config, auth paths, manifests, management JSON/human output, and
  durable records.
- Node 22.19 and Node 24 lanes.
- macOS, Linux, and Windows lanes for stdio/plugin/hook/subagent process lifecycle.
- Package smoke from the packed npm artifact.

### Live smokes

Live provider smokes read credentials only from a temporary process environment and never print
them. Anthropic live testing is credential-gated; absence of an Anthropic credential is reported as
skipped, not passed. The final local extension smoke uses the compiled Node CLI and proves no Python
process starts.

## Documentation

M7 updates:

- provider and setup documentation for Anthropic;
- MCP configuration and troubleshooting;
- configured hook approval and security behavior;
- Plugin API v2 authoring, build, manifest, protocol, and migration guidance;
- skills source precedence and stable invocation behavior;
- subagent profiles, background lifecycle, interruption, and budgets;
- management commands, doctor output, rollback, and M7/M8 ownership status.

## Acceptance Criteria

- Anthropic text/reasoning/image/tool turns complete and persist entirely in Node.
- MCP tools/resources discover, execute, interrupt, and clean up through Node.
- Skills use one stable provider tool and persist bounded replayable instructions.
- Configured hooks enforce discovery, approval digest, sandbox, timeout, output, and ordering rules.
- Plugin API v2 loads compiled ESM plugins in isolated processes and diagnoses Python plugins
  without importing them.
- Subagents preserve profiles, child sessions, foreground/background tasks, progress, messaging,
  interruption, results, recovery, and TUI events.
- Setup, management commands, and doctor run through the compiled Node CLI without Python or model
  startup.
- All retained production capabilities have a Node implementation or an explicitly approved
  removal.
- Contract generation/check, build, lint, typecheck, Node tests, Python parity tests, platform
  process tests, packed-package smoke, and available live smokes pass.
- M7 documentation is complete and `python-sidecar` remains a startup-level rollback until M8.
