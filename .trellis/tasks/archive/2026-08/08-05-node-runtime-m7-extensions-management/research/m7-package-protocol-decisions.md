# M7 Package And Protocol Decisions

## Constraints

- The approved rewrite design names `packages/integrations` as the owner of MCP,
  Plugin API v2, configured hooks, and subagents.
- `@mycli/runtime` already depends on providers, storage, tools, config, and core.
- M7 must not create an `@mycli/runtime` <-> `@mycli/integrations` cycle.
- Provider SDK, MCP SDK, Ajv, process, and filesystem types must remain in adapter
  packages and must not leak into `@mycli/core`.
- Node production builds compiled ESM and does not use a TypeScript source loader.

## Selected Package Boundary

Use one new `@mycli/integrations` package for extension discovery, adapters, process
hosts, and management services. Keep these ownership rules:

| Owner | M7 responsibility |
| --- | --- |
| `@mycli/contracts` | Versioned Plugin API v2 schemas and any gateway payload schemas |
| `@mycli/core` | Small side-effect-free extension/task value types and callback contracts only |
| `@mycli/config` | Compatible extension config readers plus atomic config/auth writers |
| `@mycli/providers` | Anthropic Messages adapter, SDK facade, provider error mapping |
| `@mycli/tools` | Generic tool routing/exposure, approval/sandbox/process facilities |
| `@mycli/storage` | Durable child-task/session records when persistence is required |
| `@mycli/integrations` | MCP, skills, configured hooks, Plugin API v2, subagent control plane, management data |
| `@mycli/runtime` | Invoke injected hook/tool/child-task contracts during turns; no SDK/process discovery |
| `@mycli/app` | Composition root, CLI routing/rendering, setup, doctor, lifecycle shutdown |

`@mycli/app` constructs integrations and injects generic tools/hooks into the runtime.
Subagents receive an injected `ChildRuntimeFactory`; `@mycli/integrations` must not
import or instantiate `NodeTurnRuntime`. This keeps the dependency direction acyclic
while ensuring parent and child turns use the same runtime implementation.

## Package Alternatives Considered

### Capability-specific packages

Separate `@mycli/mcp`, `@mycli/plugins`, `@mycli/hooks`, `@mycli/skills`, and
`@mycli/subagents` would maximize physical isolation, but these packages share
discovery precedence, diagnostics, tool contribution, process lifecycle, and
management response patterns. At the current repository size this creates excessive
manifest/build/reference overhead without improving the public product boundary.

### App-local integrations

Implementing everything under `apps/mycli` minimizes initial setup but places reusable
parsers, protocols, and state machines in the composition root. It also makes
provider-free management testing harder and conflicts with the approved architecture.

### Decision

Use one `@mycli/integrations` package with capability-specific directories and public
exports. Split a capability into its own package later only if it needs an independent
release or creates a measurable dependency problem.

## Anthropic Protocol Decision

- Add `anthropic_messages` to the existing canonical protocol union.
- Implement `AnthropicProvider` as a `ModelProvider`, preserving the same normalized
  `ProviderEvent` stream consumed by `NodeTurnRuntime`.
- Inject a narrow SDK facade for unit tests. Instantiate the official SDK only in the
  registry adapter.
- Set SDK retries to zero; mycli's runtime retry policy remains authoritative.
- Map SDK status/connection/validation errors into the existing stable provider failure
  taxonomy.
- Preserve signed thinking blocks as provider metadata required for replay, while
  keeping provider-specific structures out of generic public types where possible.

## MCP Protocol Decision

- Use `@modelcontextprotocol/sdk` `Client` and official stdio/Streamable HTTP client
  transports.
- Retain legacy remote compatibility only where Python currently accepts it. Prefer
  Streamable HTTP for newly documented configurations.
- Wrap each SDK client in a mycli-owned lifecycle object that enforces initialization,
  timeout/abort, sandboxed stdio spawning, output bounds, redaction, and close-once
  semantics.
- Validate and normalize discovered tool schemas before creating generic tool adapters.
  Discovery never mutates the built-in manifest; the combined extension discovery view
  carries `source=mcp` and stable origin metadata.

## Skill Protocol Decision

- Register exactly one generic `Skill` tool at runtime startup.
- Put the bounded catalog in model context and resolve the selected skill at execution
  time.
- Return a durable instruction-injection artifact from the tool adapter; runtime owns
  appending it to the transcript with `kind=skill_instructions`, dynamic cache class,
  persistent durability, and transcript scope.
- Never add one provider tool definition per discovered skill in the default runtime.

## Hook Protocol Decision

- Normalize built-in, configured-command, and plugin hooks behind an injected ordered
  hook runner contract.
- Configured hooks execute as external child processes using a versioned JSON stdin and
  JSON stdout envelope. A malformed or oversized response becomes an isolated hook
  error.
- Approval binds scope, hook identity, canonical command digest, and source config path.
  Any material command change invalidates approval.
- Runtime owns when hook points fire; integrations owns discovery, matching, execution,
  and safe results.

## Plugin API v2 Decision

### Manifest

The manifest must include at least:

- `api_version: 2`
- stable `id`, `name`, and optional version/description
- compiled ESM `entry`
- declared tools, hooks, commands, required environment names, and requested
  capabilities

Unknown fields may be retained for forward compatibility, but unsupported API versions,
unsafe entries, duplicate ids/names, undeclared registrations, and missing requirements
are bounded diagnostics.

### Process protocol

The host launches a package-owned worker bootstrap in a separate Node process and
passes the plugin entry path as data. Communication is newline-delimited JSON with:

- version and request id on every message
- host requests: `initialize`, `invoke`, `shutdown`
- worker responses: `registered`, `result`, `error`, `shutdown_complete`
- capability-specific invocation targets for tool, hook, and command handlers

Schemas live in `@mycli/contracts`; both sides validate incoming messages. The host
enforces one initialization phase, immutable registrations afterward, per-call timeout,
maximum message/output sizes, bounded outstanding requests, cancellation, and terminal
cleanup. A worker crash fails only its pending calls and marks that plugin unavailable.

### Source policy

Plugin authors can author TypeScript but must publish/build JavaScript ESM. Raw `.ts`,
Python `__init__.py`, and arbitrary in-process imports are rejected with migration
guidance. This preserves compiled-production and process-isolation guarantees.

## Subagent Protocol Decision

- `SubagentController` owns task/profile state and calls an injected
  `ChildRuntimeFactory.create()` with child session id, model override, frozen tools,
  transcript seed, cancellation signal, and event sink.
- Foreground invocation awaits a terminal result. Background invocation returns a task
  id immediately and publishes bounded progress/result events.
- Parent shutdown aborts owned children and awaits bounded cleanup. Restart recovery
  converts abandoned running records to an explicit interrupted/failed state unless a
  supported resumable checkpoint exists.
- No hard-coded Python-era per-turn/tool-call limit is introduced. Profile budgets are
  optional guardrails; unspecified budgets follow the main runtime's normal unbounded
  provider-step behavior subject to cancellation and existing no-progress protection.

## Management And Doctor Decision

- Use a small command router in `@mycli/app` that detects utility commands before TTY
  validation or runtime startup.
- Services return typed, JSON-serializable response objects; renderers produce stable
  human output. `--json` serializes the same object rather than scraping text.
- Doctor is a collection of independent bounded checks with stable names and severity.
  It uses read-only/provider-free checks by default and labels any explicit connection
  check. One failed collector produces one failed check, not a process crash.
- Setup uses the existing Node TUI, new atomic config/auth writers, mode `0600`, and a
  plain terminal fallback. Secrets are never returned through setup diagnostics.

## Delivery Order

1. Anthropic provider and config/profile support.
2. `@mycli/integrations` foundation, shared contracts, and composition hooks.
3. Stable Skill tool and durable instruction injection.
4. MCP discovery, adapters, lifecycle, management, and diagnostics.
5. Configured hooks and allowlist management.
6. Plugin API v2 schemas, worker host, tool/hook/command adapters, and migration checks.
7. Subagent profiles, child-runtime factory, foreground/background lifecycle, and TUI events.
8. Node setup, utility command router, doctor, docs, parity fixtures, package smoke, and
   credential-gated live smokes.

Each batch must build, typecheck, lint, and pass focused tests before the next batch.
M7 remains rollbackable to `python-sidecar`; M8, not M7, removes that backend.

