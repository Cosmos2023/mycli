# mycli Architecture

mycli is a Node.js npm workspace. The interactive CLI, gateway, runtime, tools, providers, storage,
extensions, contracts, and TUI have explicit package boundaries. Node owns every production asset,
generated declaration, test gate, and release package.

## Package Ownership

| Path | Responsibility |
| --- | --- |
| `backend/apps/mycli` | CLI entry, management routing, Node composition root, runtime-to-TUI gateway, slash command services |
| `backend/packages/contracts` | JSON schemas, generated TypeScript wire types, validation, gateway catalog |
| `backend/packages/core` | Runtime events and shared domain types without provider/storage ownership |
| `backend/packages/config` | User/project config, auth, trust, model catalog, shell settings, execution policy |
| `backend/packages/providers` | Pi-ai transport boundary, provider directory, payload adaptation, canonical normalization, and replay |
| `backend/packages/runtime` | Turn loop, continuation, approval, clarification, queue, compaction, memory, session coordination |
| `backend/packages/storage` | SQLite session store, transcript snapshots, durable state and recovery operations |
| `backend/packages/tools` | Tool manifest, file tools, approvals, process policy, PTY transports, shell lifecycle |
| `backend/packages/integrations` | Skills, MCP, hooks, plugins, subagents, discovery and management |
| `tui/mycli-shell` | Terminal rendering, input, overlays, reducer state, gateway client |
| `native/windows-sandbox-helper` | Language-neutral restricted-token Windows process helper |
| `tests/fixtures` | Frozen language-neutral M2-M7 regression corpora consumed by Node tests |

Dependencies point from composition packages toward focused libraries. `core` and contracts do not
depend on app infrastructure. Providers, filesystem, process launch, and SQLite remain behind
typed boundaries so runtime workflows can use fakes in tests.

Ordinary Responses, Chat Completions, DeepSeek, Qwen/compatible, and Anthropic traffic uses the
exact pinned `@earendil-works/pi-ai` version behind mycli's `ModelProvider` boundary. Mycli remains
authoritative for configuration, credentials, instruction roles, canonical events, replay state,
error classification, cancellation, and retry timing; every pi-ai call sets `maxRetries: 0`.

Live OpenAI Responses web search uses the same pi-ai transport. Mycli injects the provider-native
`web_search` tool through pi-ai's payload hook and rejects the capability on other protocols before
traffic. Mycli's current pi-ai integration consumes native search lifecycle and heartbeat frames
without exposing them as assistant events, so new turns retain final assistant output but do not
show canonical search progress rows or retain native search-call replay. Historical persisted search
activity remains readable.

## Interactive Flow

```text
terminal input
  -> TUI gateway request
  -> backend/apps/mycli Node gateway
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

`backend/apps/mycli/src/cli.ts` parses provider-free management commands before TTY validation. Interactive
startup unconditionally calls `startNodeBackend`; there is no alternate runtime branch.
The Node backend owns provider construction, stores, trust, tools, integrations, shell managers,
gateway transport, signals, and shutdown.

Management commands (`setup`, `doctor`, hooks, plugins, MCP, and subagents) do not start the model
runtime. This keeps automation usable without a TTY or provider request.

## Runtime And Durability

- `NodeTurnRuntime` owns provider steps and tool execution.
- `AgentSupervisor` is the only child-agent lifecycle mutator; `AgentScheduler`, `AgentRuntimePool`,
  and `AgentMailbox` provide capacity, residency, and durable communication.
- Session, queue, compaction, approval, and clarification coordinators own their durable transition.
- `SQLiteSessionStore` uses atomic operations for idempotency, effect claims, and session changes.
- `TranscriptSnapshotStore` stores bounded UI projections; it is not provider history.
- A session generation fences stale callbacks after resume/fork.
- Shutdown aborts active work, waits for settlement, drains lifecycle persistence, and closes owned
  extension and shell processes.

The runtime has no fixed provider-step or tool-call ceiling. Cancellation, provider limits,
context limits, and explicit terminal states bound execution instead.

## Layered Model Input

Every main-agent and child-agent provider step uses one provider-neutral instruction contract. The
contract separates the session-frozen product instructions, developer policy, contextual reference
data, canonical conversation, and the current user request. Workspace instructions, environment
facts, memory, ordinary hook output, compaction rehydration, and loaded skill bodies are contextual
user data. Collaboration mode, permission and sandbox policy, tool exposure, the bounded skill
catalog, trusted policy hooks, and child delegation constraints use developer authority. Untrusted
content cannot promote itself to developer authority.

The provider-step sequence is fixed:

```text
collect -> assemble -> budget -> persist -> commit -> reconstruct -> provider dispatch
```

The complete logical request is budgeted before persistence. Required product instructions,
permission policy, tool schemas, and the current user request are retained; optional sections are
trimmed deterministically. Provider transport is not invoked unless the immutable request manifest
and every referenced model-visible value have committed successfully. The provider request is then
reconstructed from committed records instead of current files or mutable runtime state.

SQLite keeps transcript rows and internal model context separate. The model-input ledger contains
content-addressed blobs, instruction snapshots, tool-set snapshots, context events, ordered
provider-input timeline events, request manifests, and provider-step lifecycle events. These records
are append-only source of truth. Within a timeline window, an ordinary request retains the complete
prior logical input as an exact prefix and appends only new conversation or changed context. Context
changes append complete superseding items, removals append tombstones, and tool results remain
contiguous before tool-generated context. Mutable `session_state` values are rebuildable projections
only.

`bootstrap`, `legacy_bootstrap`, `compaction`, and `source_reset` boundaries start explicit new
provider-input windows without rewriting old records. Manifest v2 records the window and ordered
event ids plus separate request-configuration, bootstrap-prefix, complete-timeline, and adjacent
common-prefix diagnostics. These diagnostics contain hashes and counts, never raw prompts or tool
output.

Responses, Chat Completions, and Anthropic Messages project the same durable logical contract.
Native system/developer channels are used where supported; compatibility fallback changes wire
representation without changing the persisted semantic role or chronological position. DeepSeek
maps stable developer instructions into its system prefix and appends dynamic developer context as
a user-role suffix, preserving the existing DeepSeek route behavior. Anthropic preserves developer
authority through its top-level system channel, so a dynamic developer change may reset that system
prefix even though ordinary contextual-user turns retain the message prefix. Continuation is a
separate capability-gated optimization: prompt-cache stability relies on the full append-only input,
not `previous_response_id`, and unsupported HTTP-compatible endpoints receive canonical replay.

Content forbidden from durable storage is also forbidden from provider input. Credentials,
authorization headers, transport configuration, and raw private diagnostics are never part of a
request manifest. A source that cannot be sanitized into an allowed persistable representation is
excluded before assembly and replaced with a non-sensitive diagnostic.

Legacy Node sessions remain readable. Their conversation rows and v1 provider requests are not
rewritten; the first timeline request appends a `legacy_bootstrap` boundary plus the current bounded
logical input. A session that already has a frozen instruction snapshot continues using it after a
packaged template update, while a new session receives the new template. `mycli doctor --json`
reports `model_input_ledger` integrity without opening the store in migration/write mode.

## Tool And Process Boundaries

The public built-in manifest is Node-owned. `Read` covers bounded discovery; mutation tools share a
snapshot/history runtime; shell adapters share one owner-scoped process manager. Provider tool
exposure starts from a deterministic direct set and is also enforced as an execution authorization
set. A successful, durably persisted `tool_search` result may append selected MCP or plugin schemas
to the current turn only; a new turn starts from the direct set again.

`web_fetch` is the bounded public HTTP(S) retrieval boundary. It requires a network-enabled
execution policy, rejects local/private/reserved addresses before connection, pins validated DNS
answers, revalidates redirects, and caps time, redirects, transfer bytes, media types, and
model-visible output. Returned page content is fenced as untrusted external data.

Restricted shell execution is fail-closed. Native helpers under `native/` and packaged assets under
`backend/packages/tools/native/` are Node runtime assets and must not be removed as part of language
cleanup.

## Extension Boundaries

Skills contribute instructions and a stable tool route. MCP clients and hooks use bounded process
lifecycle contracts. Plugin API v2 runs compiled ESM in isolated workers. Subagents create
independent durable Node threads with frozen least-authority policy, context, budgets, and tool
scope. Canonical agent events drive mailbox, artifact, gateway, usage, and TUI projections; the
compatibility controller owns no runtime handles or projection callback. Plugin declarations cannot
override built-in tools or slash commands. See [node-agent-runtime.md](node-agent-runtime.md).

## Contracts And Tests

Canonical schemas live in `backend/packages/contracts/schemas`; generation produces TypeScript
declarations only. The final cross-runtime comparison corpus is retained as sanitized historical
evidence under `tests/fixtures/node_runtime_m2` through `node_runtime_m7`, with hashes owned by the
M8 Node audit.

Node release gates cover build, contract drift, ESLint, TypeScript, Node unit/integration tests,
provider-free M8 smoke, packed-install smoke, native process checks, and an opt-in Responses smoke.
