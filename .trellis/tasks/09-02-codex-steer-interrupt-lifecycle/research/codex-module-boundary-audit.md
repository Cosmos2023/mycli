# Codex Module Boundary Audit

## Scope

- Audit date: 2026-09-03
- Mycli worktree: `/Users/cosmos/Desktop/mycli/.worktrees/mycli-agent-worker-pool`
- Comparison source: `/Users/cosmos/Downloads/codex-main`
- Method: read-only source comparison. This document identifies structural hotspots and does not
  add speculative items to `confirmed-bug-ledger.md`.

## Conclusion

Mycli has already created useful package boundaries (`config`, `providers`, `tools`, `runtime`,
`storage`, and `integrations`). The remaining problem is that the live execution path recombines
too many concerns in a few application-layer objects. The result is not simply large files: the
same mutable truth is held by the gateway, runtime, storage projection, and TUI at once.

Codex is also a large system, but its key boundaries are explicit:

- `core/session/{session,turn,input_queue}` owns turn-local and session-local execution state.
- `core/tools/{registry,router,lifecycle,runtimes,handlers}` separates tool definition,
  dispatch, lifecycle notifications, and effect execution.
- `state/{model,runtime}` owns durable models and recovery-oriented operations.
- `app-server/request_processors/*` owns RPC-domain request handling, while
  `app-server-protocol` owns typed event projection.
- The TUI consumes typed thread items rather than extracting presentation data from untyped
  metadata fallbacks.

## High-Priority Structural Hotspots

### 1. Gateway RPC, session control, and event projection are one object

**Mycli evidence**

- `backend/apps/mycli/src/node-runtime/node-gateway.ts` is 5,632 lines.
- `InProcessNodeGateway` owns JSON-RPC parsing and responses, turn admission, session switching,
  queue scheduling, approvals, clarification, interactive-request FIFO, settings, model
  selection, workspace trust, permissions, shell control, slash-command implementation,
  transcript payloads, and runtime-event shaping.
- It keeps mutable state such as `#activeTurn`, `#turnAdmissionPending`,
  `#sessionTransitionActive`, `#sessionControlActive`, `#interactiveRequests`, trust,
  permission, provider/model, and collaboration-mode fields.
- The existing ledger already confirms consequences of this split: session-control locking
  (`#35`), delayed session/command effects (`#42`, `#44`), and incomplete event ownership
  fencing (the uncounted candidate below the ledger).

**Codex contrast**

- `codex-rs/app-server/src/message_processor.rs` routes request domains to dedicated request
  processors and keeps request serialization in `request_serialization.rs`.
- `codex-rs/app-server/src/request_processors/turn_processor.rs`, `thread_processor.rs`,
  `config_processor.rs`, and other domain processors own their respective RPC behavior.
- `codex-rs/app-server-protocol/src/protocol/event_mapping.rs` maps core events into typed server
  notifications outside the request processor.

**Needed boundary**

Keep the gateway as transport, request validation, and response writing only. Move operations to
session, turn, interactive, shell, and settings controllers that share one operation/ownership
coordinator. Put event ownership stamping and typed event mapping in a dedicated projection
layer.

### 2. Turn execution combines too many independent state machines

**Mycli evidence**

- `backend/packages/runtime/src/node-turn-runtime.ts` is 2,888 lines.
- It owns reservation, provider looping and retry, context compaction, memory collection,
  approval/clarification continuation, tool batching and parallelism, active-tool interruption,
  tool persistence, terminal snapshots, budgets, and runtime event emission.
- Several collaborators already exist (`ProviderStepExecutor`, `ToolRouter`,
  `CompactionCoordinator`, `ExecutionPolicyCoordinator`), but `NodeTurnRuntime` still decides
  their lifecycle ordering and terminal persistence directly.

**Codex contrast**

- Codex separates session and turn behavior under `core/session/`, input buffering in
  `session/input_queue.rs`, context processing in `context_manager/`, compaction in `compact.rs`,
  and tool lifecycle in `tools/lifecycle.rs`.

**Needed boundary**

Introduce a small turn orchestrator that owns only legal state transitions. Provider loop, tool
executor, continuation executor, context builder, and terminalizer should be independent
participants. A single durable terminalization command must be the only route to completed,
failed, interrupted, and suspended states.

### 3. The TUI reducer is both a state machine and a compatibility parser

**Mycli evidence**

- `tui/mycli-shell/src/adapters/runtime-state.ts` is 5,557 lines.
- It handles gateway event reduction, queue reconciliation, transcript pagination and merging,
  streaming, tool and shell lifecycle presentation, file-change previews, plan rendering,
  approvals, clarifications, session trees, settings/catalog parsing, provider parsing, and
  visual settings normalization.
- `tui/mycli-shell/src/gateway.ts` separately keeps mutable client dispatch state for busy status,
  interrupt intent, local queue scheduling, event deduplication, and both TUI implementations.
- Much of the reducer recovers display fields from `Record<string, unknown>` and multiple legacy
  metadata locations, rather than consuming a single typed transcript-item contract.

**Codex contrast**

- Codex maps core events into typed `ThreadItem` variants in app-server protocol before they reach
  consumers. Its TUI separates application state (`tui/src/app.rs`) from app-server session
  transport (`tui/src/app_server_session.rs`).

**Needed boundary**

Split mycli into a typed event decoder, a session/turn reducer, a transcript projector, and
feature-specific presenters. The UI should not decide whether a durable lifecycle transition is
valid; it should apply a fully identified event (`session_id`, generation, turn/run ID, sequence).

### 4. Native chat duplicates an interactive ingress path

**Mycli evidence**

- `tui/mycli-shell/src/native-chat-runtime.ts` owns its own readline submission, clarification
  routing, Ctrl+C behavior, prompt rendering, transcript deduplication, and status rendering.
- It bypasses parts of the regular shell runtime's input and selector flow. Confirmed ledger
  items `#52` through `#54`, `#60` through `#63`, and `#66` all stem from this second ingress
  path.

**Codex contrast**

- Codex's interactive TUI shares the app-server thread protocol. Its `exec` binary is a separate
  non-interactive output consumer rather than a second partial chat lifecycle implementation.

**Needed boundary**

Either retire native chat or make it a thin rendering/input adapter over the same command/action
dispatcher used by the default TUI. It must not decide approval, clarification, interrupt, or
queue behavior locally.

### 5. Storage mixes durable domain transitions with display projections and maintenance

**Mycli evidence**

- `backend/packages/storage/src/sqlite-session-store.ts` is 2,942 lines.
- It handles schema initialization/migration, turn reservation and terminalization, canonical
  conversation, transcript/history/rollout display projections, queue commits, approvals,
  clarification, compaction, session forks, shell output, storage maintenance, and process-owner
  checks.
- The confirmed lifecycle failures involving half-completed transitions show that durable task,
  thread, queue, and transcript mutations are not consistently exposed as one transactional
  domain operation.

**Codex contrast**

- Codex keeps durable state models and runtime/recovery operations in distinct `state/model/` and
  `state/runtime/` modules. App-server processors call those domain operations rather than
  formatting transcript presentation data in the same storage component.

**Needed boundary**

Keep SQLite mechanics and migrations in a store layer; move turn/continuation/queue and agent
repositories into focused domain repositories. Use a transaction plus outbox/projection boundary
for terminal transitions so an event cannot claim success before durable state and required
projections agree.

### 6. Permission and sandbox policy has more than one mutable owner

**Mycli evidence**

- Policy inputs live across config and workspace trust, session preferences, gateway fields,
  `ExecutionPolicyCoordinator`, `ApprovalPolicy`, shell/file tool adapters, and the native helper.
- `node-gateway.ts` caches `#trustState` and `#permissionProfile` and also performs policy mapping
  for UI payloads. `NodeTurnRuntime` separately configures the approval policy and begins a
  turn-scoped policy snapshot.
- Confirmed ledger item `#35` shows that one gateway mutation path was not covered by the same
  session-control lock.

**Codex contrast**

- Codex resolves permission profiles in its configuration layer and passes an explicit per-thread
  settings/policy snapshot into core execution. Tool handlers consume that snapshot rather than
  owning session policy mutations.

**Needed boundary**

Create one immutable `EffectiveExecutionPolicy` snapshot for each run. Configuration and session
commands request a policy change through one controller; gateway and TUI only display the resolved
snapshot. Tool adapters should receive policy, not reconstruct it.

## Medium-Priority Structural Hotspots

### 7. Tool exposure is assembled in several layers

`node-backend.ts` combines built-in manifest entries, integration registrations, deferred
tool-search candidates, plan-mode filtering, request-permission exposure, runtime tool routing,
and prompt context. `integration-composition.ts`, `tools/router.ts`, and
`runtime/instruction-context.ts` each own a portion of that surface. The individual packages are
reasonable, but the catalog version and the model-visible tool set are not represented by one
authoritative immutable object.

Codex has a dedicated tools registry/spec/discovery stack plus explicit dynamic-tool protocol
types. Mycli should introduce a versioned `ToolCatalogSnapshot` consumed by prompt assembly,
router dispatch, `tool_search`, gateway manifests, and TUI diagnostics.

### 8. Context, compaction, and replay have overlapping representations

Mycli has good dedicated modules (`model-input-pipeline`, `provider-input-timeline`,
`memory-context-service`, `context-item-coordinator`, and `compaction-coordinator`), but the
live runtime still decides their ordering and persists parts of the result in several forms.
Confirmed item `#19` demonstrates that the recovery path can reuse the same oversized history.

This is not a reason to merge the modules. It needs a single context-window contract: one input
builder produces an immutable provider request, one compaction operation replaces a declared
window, and one replay record identifies exactly which input was sent.

### 9. Node backend composition is an application-policy hotspot

`backend/apps/mycli/src/node-runtime/node-backend.ts` is 4,008 lines. A composition root can be
large, but this one also resolves runtime configuration, builds storage and shell services,
constructs child-agent factories, wires mailbox/terminal callbacks, builds tool surfaces, creates
per-session runtimes, configures policy, and performs startup/shutdown recovery.

Split it by lifecycle ownership: bootstrap/configuration, root-session runtime factory,
subagent-runtime factory, tool/integration catalog factory, and shutdown supervisor. This lowers
the chance that one callback bypasses a coordinator.

## Areas That Are Relatively Well-Bounded

- `backend/packages/config/` already has separable layers for paths, config layers, model catalog,
  provider profiles, auth, trust, user editing, and managed policy. Avoid a broad config rewrite.
- `backend/packages/providers/` has a registry/directory boundary and is a better candidate for
  incremental provider fixes than for structural replacement.
- Static tool definitions are separated from the file-mutation runtime. The remaining file-tool
  work is primarily the transaction/approval/presentation boundary, not a need to delete
  `Write`, `Edit`, or `Patch`.
- `backend/packages/integrations/` has useful MCP, plugins, hooks, skills, and subagent folders;
  its principal issue is how runtime composition publishes and refreshes a combined catalog.

## Refactor Order

1. Finish the shared lifecycle/ownership state machine first; it is the prerequisite for every
   reliable controller boundary.
2. Extract gateway controllers and typed event projection.
3. Split TUI decoding/reduction/projection and remove native chat as an independent lifecycle.
4. Introduce transactional domain repositories and a single terminalization/outbox path.
5. Snapshot policy and tool catalog per run.
6. Narrow `NodeTurnRuntime` and `node-backend.ts` after the contracts above exist.

## Test Consequence

The system needs contract tests at the boundaries, not only very large end-to-end tests:

- state-transition tables for turn, queue, approval, clarification, and agent task/thread state;
- event ownership and stale-event rejection fixtures;
- SQLite failure-injection tests for every multi-row terminal transition;
- adapter conformance tests proving default TUI and native/CLI input use the same actions;
- tool-catalog and policy-snapshot contract tests.
