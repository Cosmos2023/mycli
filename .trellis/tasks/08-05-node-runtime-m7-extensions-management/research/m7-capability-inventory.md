# M7 Capability Inventory

## Scope

This inventory maps the remaining Python-owned production capabilities to the Node
runtime. It is a parity inventory, not a request to translate Python modules line by
line. The approved rewrite design remains the source of truth where it intentionally
replaces Python behavior.

## Current Node Baseline

- `@mycli/providers` implements OpenAI Responses and Chat Completions behind one
  `ModelProvider.stream()` boundary.
- `@mycli/runtime` owns turn orchestration, tool continuations, cancellation, retry,
  recovery, compaction, memory, and event emission.
- `@mycli/tools` owns built-in tool schemas, routing, approvals, sandbox policy,
  process control, and persistent shell transports.
- `@mycli/config` reads compatible TOML and auth data but does not yet write setup
  configuration or credentials.
- `@mycli/app` only parses interactive runtime flags. The Node setup TUI and the TUI
  resource/subagent surfaces already exist, but Python still prepares setup state,
  persists setup results, and owns utility command routing.

## Anthropic Messages

Python references:

- `src/mycli/llms/adapters/anthropic_messages_adapter.py`
- `src/mycli/llms/clients/anthropic_messages.py`

Parity behavior to retain:

- Add `anthropic` and `anthropic_messages` to the provider-neutral config types and
  profile validation.
- Serialize system/developer instructions separately from alternating user and
  assistant messages.
- Preserve text, image, tool-use, tool-result, and signed thinking blocks.
- Produce stable unique provider tool-use ids and match tool results to the original
  call id.
- Support multiple tool calls, incremental text/thinking/tool-input events, usage,
  stop reasons, cancellation, bounded retry classification, and terminal failures.
- Preserve Anthropic cache-control behavior without exceeding four explicit cache
  breakpoints.
- Keep provider payloads and API credentials out of normal diagnostics.

Current SDK research:

- `@anthropic-ai/sdk` latest metadata on 2026-08-05 is `0.115.0` (MIT).
- The package exports ESM entry points and typed message/streaming APIs. It has no
  stricter published Node engine floor than the repository's Node `>=22.19.0` floor.
- The SDK belongs only in `@mycli/providers`; its types must not leak into core or
  runtime contracts.

## MCP

Python references:

- `src/mycli/services/mcp/client.py`
- `src/mycli/services/mcp/tool_adapter.py`
- `src/mycli/services/mcp/resource_adapter.py`
- `src/mycli/services/mcp/diagnostics.py`
- `src/mycli/services/mcp/management.py`

Parity behavior to retain:

- Discover user and repository configuration with deterministic precedence and
  bounded parse diagnostics.
- Support local `stdio`, compatible HTTP, and Streamable HTTP servers.
- Initialize once, list tools/resources, call tools, read resources, propagate
  cancellation, and close transports/process trees deterministically.
- Run local stdio servers through the existing sandbox and safe process environment
  policies. Never print commands, args, headers, or environment values in diagnostics.
- Project MCP tools through stable ids `mcp:<server>:<tool>` and provider-safe route
  names. Validate input schemas before exposure and execution.
- Bound text, structured data, images, and raw output. Preserve `is_error` semantics.
- Keep discovery and management provider-free. `mcp list|inspect` and doctor may
  connect only where the command/check contract explicitly requires it.

Current SDK research:

- `@modelcontextprotocol/sdk` latest metadata on 2026-08-05 is `1.30.0` (MIT), with
  Node `>=18`; it is compatible with the repository's Node floor.
- The SDK's stable client supports `listTools`, `callTool`, `listResources`, and
  `readResource`, with stdio and Streamable HTTP transports. Legacy HTTP+SSE is a
  compatibility transport, not the preferred remote path.
- Use the official SDK rather than retaining the Python client's hand-built JSON-RPC
  transport. mycli remains responsible for config validation, sandboxing, output
  bounds, redaction, naming, and process-tree cleanup.

## Skills

Python references:

- `src/mycli/services/skills/registry.py`
- `src/mycli/services/skills/provider.py`

Parity behavior to retain:

- Discover `*.md` and `*/SKILL.md` definitions from builtin, user, shared-repository,
  and repository roots with deterministic later-source precedence.
- Parse TOML or YAML frontmatter, require non-empty `name` and `description`, and
  retain trigger hints, dependency hints, guardrails, source kind, and body.
- Report malformed and duplicate definitions without preventing unrelated skills from
  loading.
- Expose one stable provider-visible `Skill` tool plus a bounded skill catalog.
  Adding or removing skills must not change the default provider tool schema.
- On success, append fenced skill instructions as a durable dynamic transcript item,
  not as a replacement user request. Missing skills fail as normal tool results.

The Python per-skill contribution provider is a legacy compatibility reference. The
tool-manifest contract's stable `Skill` tool takes precedence for Node.

## Configured Command Hooks

Python references:

- `src/mycli/services/hooks/config.py`
- `src/mycli/services/hooks/allowlist.py`
- `src/mycli/services/hooks/runner.py`
- `src/mycli/services/hooks/manager.py`
- `src/mycli/services/hooks/management.py`

Parity behavior to retain:

- Discover user and repository `.mycli/hooks.json`, including the current flat shape
  and supported Codex-style event groups.
- Support `pre_tool_use`, `post_tool_use`, `user_prompt_submit`, `stop`,
  `pre_compact`, `session_start`, and `session_end` ordering and matchers.
- Keep hooks language-neutral commands. Validate command form, working directory,
  safe environment policy, and a timeout in `(0, 30]` seconds.
- Require an allowlist record tied to the command digest. Disabled, changed,
  unapproved, or malformed hooks fail closed.
- Execute through existing process sandbox/process-tree facilities with bounded
  stdin/stdout/stderr and redacted diagnostics.
- Isolate hook failures into `allow`, `deny`, `modify`, or `error` results without
  corrupting the turn/session state.
- Preserve provider-free `hooks list|inspect|approve|revoke` human and JSON output.

## Plugin API v2

Python references:

- `src/mycli/services/plugins/manifest.py`
- `src/mycli/services/plugins/discovery.py`
- `src/mycli/services/plugins/host.py`
- `src/mycli/services/plugins/runtime.py`
- `src/mycli/services/plugins/commands.py`
- `.trellis/spec/backend/plugin-runtime-contract.md`

The Node design intentionally replaces Python source loading:

- Discover repo/user directory plugins, with user source winning duplicate ids and
  disabled entries winning enablement conflicts.
- Require a versioned v2 manifest and a compiled ESM worker entry. Authors may write
  TypeScript, but production mycli does not execute raw `.ts` through `tsx` or another
  source loader.
- Spawn each enabled plugin in its own child process. Apply existing sandbox, minimal
  environment, timeouts, output limits, process-tree cleanup, and crash isolation.
- Use a bounded JSON-lines protocol with request ids and explicit
  `initialize/register/invoke/shutdown` message variants validated by JSON Schema.
- Let plugins declare tools, hooks, and provider-free commands. Host-side registries
  validate names/schemas and expose stable `plugin:<plugin>:<name>` ids.
- A plugin cannot receive arbitrary host objects, import mycli internals, mutate host
  registries after initialization, or emit unbounded diagnostics.
- `plugins list|inspect|run` remains provider-free. Python plugins are diagnosed as
  migration-required and are never imported by Node.

## Subagents

Python references:

- `src/mycli/services/subagents/`
- `src/mycli/application/runtime/subagents/`

Parity behavior to retain:

- Discover builtin, user, and repository profiles with deterministic precedence,
  validation, allowed/denied tool scopes, optional model selection, and bounded
  budgets.
- Run foreground and background child sessions with explicit parent ownership and a
  child-specific frozen tool scope.
- Reuse the Node turn runtime through an injected child-runtime factory rather than a
  second agent loop.
- Persist child task state, progress, usage, terminal result, and output reference;
  recover nonterminal tasks conservatively after restart.
- Support interruption, no-progress termination, result collection, and parent
  shutdown cleanup.
- Emit the existing bounded task/subagent events consumed by the TUI. Never insert raw
  child provider payloads or unrestricted tool output into diagnostics.
- Preserve provider-free `subagents list|inspect` output.

## Setup, Management, Doctor, And Migration

Python references:

- `src/mycli/cli/setup_wizard.py`
- `src/mycli/cli/main.py`
- `src/mycli/services/diagnostics/doctor.py`

Required Node ownership:

- Route `setup`, `doctor`, `hooks`, `plugins`, `mcp`, and `subagents` before requiring
  a TTY or starting a provider/runtime.
- Preserve `--json` management output and nonzero exit status for invalid/failed
  operations.
- Keep the existing setup TUI, but move setup-state construction, config/auth atomic
  writes, permissions, and fallback prompt behavior into Node.
- Extend auth/config writing without ever echoing the API key. Preserve existing
  config and auth paths and file modes.
- Implement doctor as small provider-free collectors. Reuse current Node stores and
  validators rather than porting the 4,436-line Python service literally.
- Cover config/auth, Node version/package, SQLite/storage, contracts, tool manifests,
  hooks, plugins, skills, subagents, MCP, process/sandbox support, redaction, and
  migration compatibility.
- Report Python plugin directories as actionable migration diagnostics. Do not import,
  execute, or auto-convert Python source.

## Testing Inventory

- Unit: provider serialization/events, config parsers, schema validators, precedence,
  naming, output bounding, hook policies, plugin protocol, subagent state machines,
  doctor status reduction, and CLI parsing/rendering.
- Integration: real local MCP server, plugin worker, configured hook command, child
  subagent runtime, SQLite persistence/recovery, timeouts, cancellation, crashes, and
  process-tree cleanup.
- Parity: Python fixtures for retained config, manifests, human/JSON management output,
  tool projection, and durable records.
- Platform: Node 22.19 and 24 across macOS/Linux/Windows for process-sensitive paths.
- Live smoke: Anthropic provider is optional/credential-gated; the M7 exit smoke must
  also prove a full Node launch with local extensions and no Python process.

