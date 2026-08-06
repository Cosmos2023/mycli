# mycli Architecture

mycli's npm application is a Node.js workspace. The interactive CLI, gateway, runtime, tools,
providers, storage, extensions, contracts, and TUI have explicit package boundaries; no npm
production package imports or starts Python. The original Python implementation is retained as an
independently launched reference runtime.

## Package Ownership

| Path | Responsibility |
| --- | --- |
| `apps/mycli` | CLI entry, management routing, Node composition root, runtime-to-TUI gateway, slash command services |
| `packages/contracts` | JSON schemas, generated TypeScript wire types, validation, gateway catalog |
| `packages/core` | Runtime events and shared domain types without provider/storage ownership |
| `packages/config` | User/project config, auth, trust, model catalog, shell settings, execution policy |
| `packages/providers` | Responses, Chat Completions, and Anthropic provider adapters and streaming normalization |
| `packages/runtime` | Turn loop, continuation, approval, clarification, queue, compaction, memory, session coordination |
| `packages/storage` | SQLite session store, transcript snapshots, durable state and recovery operations |
| `packages/tools` | Tool manifest, file tools, approvals, process policy, PTY transports, shell lifecycle |
| `packages/integrations` | Skills, MCP, hooks, plugins, subagents, discovery and management |
| `tui/mycli-shell` | Terminal rendering, input, overlays, reducer state, gateway client |
| `native/windows-sandbox-helper` | Language-neutral restricted-token Windows process helper |
| `src/mycli` | Retained Python 3.13 reference implementation, launched with `uv run mycli` |

Dependencies point from composition packages toward focused libraries. `core` and contracts do not
depend on app infrastructure. Providers, filesystem, process launch, and SQLite remain behind
typed boundaries so runtime workflows can use fakes in tests.

## Interactive Flow

```text
terminal input
  -> TUI gateway request
  -> apps/mycli Node gateway
  -> runtime coordinator
  -> provider and/or tool adapter
  -> durable SQLite commit
  -> canonical lifecycle events
  -> TUI reducer and transcript
```

The gateway acknowledges work only after the required durable reservation. User messages emit
canonical item lifecycle events after commit. Approvals and clarifications persist their pending
state before the UI is told to wait, allowing restart recovery without replaying a tool effect.

## Composition Root

`apps/mycli/src/cli.ts` parses provider-free management commands before TTY validation. Interactive
startup unconditionally calls `startNodeBackend`; there is no runtime router or sidecar branch.
The Node backend owns provider construction, stores, trust, tools, integrations, shell managers,
gateway transport, signals, and shutdown.

Management commands (`setup`, `doctor`, hooks, plugins, MCP, and subagents) do not start the model
runtime. This keeps automation usable without a TTY or provider request.

## Runtime And Durability

- `NodeTurnRuntime` owns provider steps and tool execution.
- Session, queue, compaction, approval, and clarification coordinators own their durable transition.
- `SQLiteSessionStore` uses atomic operations for idempotency, effect claims, and session changes.
- `TranscriptSnapshotStore` stores bounded UI projections; it is not provider history.
- A session generation fences stale callbacks after resume/fork.
- Shutdown aborts active work, waits for settlement, drains lifecycle persistence, and closes owned
  extension and shell processes.

The runtime has no fixed provider-step or tool-call ceiling. Cancellation, provider limits,
context limits, and explicit terminal states bound execution instead.

## Tool And Process Boundaries

The public built-in manifest is Node-owned. `Read` covers bounded discovery; mutation tools share a
snapshot/history runtime; shell adapters share one owner-scoped process manager. Provider tool
exposure is frozen at turn start and is also enforced as an execution authorization set.

Restricted shell execution is fail-closed. Native helpers under `native/` and packaged assets under
`packages/tools/native/` are Node runtime assets and must not be removed as part of language
cleanup.

## Extension Boundaries

Skills contribute instructions and a stable tool route. MCP clients and hooks use bounded process
lifecycle contracts. Plugin API v2 runs compiled ESM in isolated workers. Subagents create child
Node runtimes with frozen tool scopes and durable parent ownership. Plugin declarations cannot
override built-in tools or slash commands.

## Contracts And Tests

Canonical schemas live in `packages/contracts/schemas`; generation produces TypeScript plus the
Python runtime's schema resource copies. The
last Python/Node comparison corpus remains as sanitized JSON under `tests/fixtures/node_runtime_m2`
through `node_runtime_m7`, with hashes owned by the M8 Node audit.

Node release gates cover build, contract drift, ESLint, TypeScript, Node unit/integration tests,
provider-free M8 smoke, packed-install smoke, native process checks, and an opt-in Responses smoke.
The retained Python runtime keeps separate pytest, ruff, mypy, packaging, and cross-backend gates.
