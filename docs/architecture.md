# mycli Architecture

mycli is a Node.js npm workspace. The interactive CLI, gateway, runtime, tools, providers, storage,
extensions, contracts, and TUI have explicit package boundaries. Node owns every production asset,
generated declaration, test gate, and release package.

## Package Ownership

| Path | Responsibility |
| --- | --- |
| `backend/apps/mycli` | CLI entry, management routing, Node composition root, runtime-to-TUI gateway, slash command services |
| `backend/packages/contracts` | JSON schemas, generated TypeScript wire types, validation, gateway catalog |
| `backend/packages/gateway` | Client-independent Node transport interfaces, shared RPC client, notification decoding and client lifetime |
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

Responses streaming ends at the protocol terminal event, without waiting for the HTTP response
body to reach EOF. A provider-local SSE adapter closes the stream presented to pi-ai after the
terminal frame and cancels remaining input; pi-ai still interprets the final content, tools, usage,
and status. The canonical adapter likewise stops reading at pi-ai's `done` or `error` event.
Missing or malformed completion remains a stream failure. Runtime can continue with tools or
another model step, and the TUI stops its timer only after the turn's normal terminalization.

The TUI derives dim horizontal separators before new assistant text blocks after visible work in
the current turn. These are display-only transcript blocks shared by live rendering and historical
viewing. Stable message ids and cached source-boundary state preserve placement during streaming,
tool grouping, and resize; user messages and completed-turn markers reset the work boundary.

Shell blocks use one blank row between commands and trim only visibly empty output boundary rows
for display, preserving internal whitespace and retained output. Live turn activity occupies the
status area above the composer with explicit spacing and a single width-bounded header. It stays
outside transcript scrolling and native history; status updates do not invalidate transcript
content. Completed-turn duration remains part of the transcript.

Live OpenAI Responses web search uses the same pi-ai transport. Mycli injects the provider-native
`web_search` tool through pi-ai's payload hook and rejects the capability on other protocols before
traffic. Mycli's current pi-ai integration consumes native search lifecycle and heartbeat frames
without exposing them as assistant events, so new turns retain final assistant output but do not
show canonical search progress rows or retain native search-call replay. Historical persisted search
activity remains readable.

## Package Module Layout

Within each backend package, `src/` groups modules by responsibility and `test/` mirrors those
groups. `src/index.ts` remains the package facade. Existing package names and public subpaths,
including `@mycli/config/profile`, `@mycli/config/paths`, and `@mycli/tools/ripgrep-runtime`, stay stable.

| Package | Where to look |
| --- | --- |
| config | `configuration/` for layers, schema and editing; `providers/` for auth and models; `policy/` for trust; `terminal/` for shell and TUI settings |
| contracts | `gateway/` for shared UI/runtime data; `generated/` for schema-generated types; root for schema loading and validation |
| gateway | `client.ts` for RPC correlation and notification consumption; `transport.ts` for the client-independent stream interface |
| core | `conversation/` for model input and projection; `lifecycle/` for agent, turn and queue state; `policy/` for pure policy rules |
| integrations | `foundation/`, `hooks/`, `mcp/`, `plugins/`, `skills/`, `subagents/` for extension subsystems |
| providers | `registry/` for route discovery and provider construction; `pi-ai/` for transport, payload, replay and failure adaptation |
| runtime | `turns/` for turn ownership; `workers/` for Worker execution; `agents/` for scheduling; `providers/`, `context/`, `memory/`, `sessions/`, `hooks/`, `tools/` for coordinated workflows |
| storage | `sessions/` for SQLite session state; `transcript/` for event persistence; `projections/` for derived views and model input; `artifacts/` for content blobs; `agents/` for child state; `migrations/v9/` and `migrations/v10/` for versioned migrations |
| tools | `files/`, `shell/`, `sandbox/`, `ripgrep/` for execution adapters; `policy/` for permissions; `registry/` for discovery and routing; `interaction/` for questions and plans |
| mycli-shell-tui | `application/` for session composition; `state/` for reducers and recovery; `transcript/` for display projection; `components/` grouped into transcript, selectors, composer and shared widgets; `transport/`, `platform/`, `interaction/`, `theme/`, `tui-core/` for their respective boundaries |

Package-wide primitives remain at the source root. Shared test helpers live in `test/support/`,
and shared assets in `test/fixtures/`. Internal modules import their owning files directly;
directory groups do not introduce additional public APIs or dependency layers.

The [TUI architecture guide](../tui/mycli-shell/README.md) documents its state-to-render pipeline,
cache ownership and import rules. TUI architecture tests reject reverse dependencies and cycles;
static output and interactive updates share one transcript cell factory.

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

`backend/apps/mycli/src/cli.ts` routes management, exec/review, and stdio app-server commands before
TTY validation. Agent startup uses `startSupervisedNodeBackend`; its coordinator Worker composes
the same `startNodeBackend` runtime for every client.
The Node backend owns provider construction, stores, trust, tools, integrations, shell managers,
gateway transport, signals, and shutdown.

Management commands (`setup`, `doctor`, hooks, plugins, MCP, and subagents) do not start the model
runtime. This keeps automation usable without a TTY or provider request.

## Runtime And Durability

- `NodeTurnRuntime` owns provider steps and tool execution.
- `AgentSupervisor` is the only child-agent lifecycle mutator; `AgentScheduler`, `AgentRuntimePool`,
  and `AgentMailbox` provide capacity, residency, and durable communication.
- Session, queue, compaction, approval, and clarification coordinators own their durable transition.
- `SQLiteTranscriptEventRepository` uses atomic operations for idempotency, effect claims, and session changes.
- `TranscriptSnapshotStore` stores bounded UI projections; it is not provider history.
- A session generation fences stale callbacks after resume/fork.
- Shutdown aborts active work, waits for settlement, drains lifecycle persistence, and closes owned
  extension and shell processes.

The runtime has no fixed provider-step or tool-call ceiling. Cancellation, provider limits,
context limits, and explicit terminal states bound execution instead.

Provider requests cross the Worker boundary with a bounded 32 MiB payload budget, including native
replay state and images that are not fully represented by conversation token counts. Pre-dispatch
byte-limit failures carry explicit local context-overflow diagnostics and enter reactive compaction.
Rejected requests consume no wire sequence number, allowing the compacted timeline to continue on
the same lease. Worker memory limits and malformed-response fencing remain separate controls.

Within a compatible tool phase, `ParallelApprovalCoordinator` persists each call's approval and
wakes it independently. The gateway displays one prompt at a time and advances after a decision;
the active turn and Worker lease remain owned. Approved Shell calls retain their normal output
wait, so another approved call can start and finish before an earlier invocation returns.
Live completion follows execution order, while durable results and the next model request follow
provider order. File mutations and other sequential tools retain barriers.

Approval choices and frozen calls live in the suspended batch state. The existing effect ledger
claims execution using stable session/turn/call IDs. Cold session activation retains completed
results and interrupts unfinished turns, clearing unanswered approvals and questions atomically.
Unknown effects are recorded without replay. Reattaching a client to a live backend retains its
pending requests and processes. Transcript terminalization preserves completed sibling results
when another call fails.

The TUI and headless workflows consume one `@mycli/gateway` client. Backend transport interfaces
are independent of the TUI, with lint enforcing that dependency direction. Per-method schemas in
contracts generate request/result types and validate payloads before dispatch and delivery.
Transcript projection uses the shared wire record while preserving version 1 metadata compatibility.
The installed application exposes `/backend` and `/gateway` APIs; see [Gateway API](gateway.md).

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

Domain-constrained Shell networking on macOS uses one immutable HTTP/CONNECT proxy lease per
process. Seatbelt permits only that lease's loopback TCP port; proxy environment variables provide
client routing. Shared public-address validation rejects local/private destinations and pins DNS
through the actual connection. The shell manager retains the lease after yield and closes it on
exit, stop, timeout, startup failure, and shutdown. Linux and Windows reject enabled non-empty
domain policies until native proxy routing exists. CONNECT filters its destination authority,
not encrypted request content. See [Network Policy](network-policy.md) for configuration and limits.

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
