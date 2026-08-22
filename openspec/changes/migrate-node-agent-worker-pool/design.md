## Context

The Node CLI already separates the TUI/supervisor main thread from one backend Worker. The backend Worker currently owns durable state, integrations, the root runtime, and every subagent runtime. Root and child turns are independent Promises, but they share one JavaScript event loop and cannot be forcefully terminated independently. The outer supervisor first requests cooperative cancellation and then restarts the entire backend Worker when a turn remains blocked.

The durable runtime already provides most of the correctness substrate needed for a narrower execution boundary: canonical session and turn identities, append-only conversation state, model-input snapshots and manifests, content hashes, subagent thread/task/mailbox records, approval continuations, tool lifecycle records, and process-tree cleanup. The migration must preserve these contracts while moving only active agent loops into reusable Workers.

Node 24 provides `worker_threads` but no built-in general-purpose Worker Pool. Generic pools such as Piscina optimize stateless jobs and do not provide mycli's durable lease, approval, tool-effect, provider-commit, interruption, and recovery semantics. The pool will therefore use Node built-ins and a mycli-owned protocol.

## Goals / Non-Goals

**Goals:**

- Run a root turn and active subagent turns on distinct JavaScript execution hosts with true parallelism.
- Make non-cooperative hard interruption target only the Worker leased to the affected turn.
- Preserve a single durable ordering and side-effect authority in the coordinator.
- Prevent stale, duplicate, reordered, cross-lease, and ABA-shaped messages from producing durable or external effects.
- Avoid repeatedly cloning stable conversation prefixes across the Worker boundary.
- Bound common-case memory through elastic Worker creation, idle retirement, compact Worker entrypoints, bounded caches, and resource-aware scheduling.
- Migrate incrementally behind the existing runtime interfaces and retain a tested in-process adapter until root parity is proven.

**Non-Goals:**

- Removing or changing Python mycli.
- Giving Agent Workers direct SQLite, gateway, approval UI, MCP, plugin, hook, shell-process, or session-artifact ownership.
- Spawning a complete mycli OS process for every subagent.
- Running two active turns concurrently on one Worker.
- Depending on `previous_response_id`; providers that support continuation may use it, but correctness and memory bounds cannot require it.
- Claiming exactly-once completion for arbitrary external effects whose outcome cannot be proven after termination.
- Changing public TUI, slash-command, agent-tool, session, or launch contracts as part of this migration.

## Decisions

### Make the backend Worker a coordinator and lease reusable Agent Workers

The existing backend Worker becomes the coordinator. It owns an elastic pool of reusable `worker_threads.Worker` instances. Every active root or child turn obtains one exclusive lease for the duration of its agent loop; idle logical sessions retain no Worker.

The default maximum pool capacity is four, matching the current logical resident limit and allowing one root plus three child turns to execute concurrently. Interactive root work has priority over background child work, with FIFO ordering inside each priority class. Queue length, Worker startup, idle, cancellation, and shutdown durations are bounded.

A permanent Worker per logical session was rejected because idle sessions would retain V8 isolates and caches, runtime state could diverge from SQLite, and eviction would become a session correctness concern. A process per child was rejected because it duplicates the full CLI/runtime and weakens shared persistence and approval ordering. A generic pool dependency was rejected because exclusive durable leases and targeted recovery remain custom even when Worker creation is delegated.

### Extract a transport-neutral AgentLoop before crossing the Worker boundary

`NodeTurnRuntime` currently combines provider-loop decisions, storage, tools, approvals, context assembly, event publication, and terminalization. The first migration step extracts a transport-neutral `AgentLoop` whose required effects are expressed through an asynchronous broker contract.

An in-process broker adapter preserves current behavior and becomes the parity oracle. The Worker-backed adapter implements the same contract over the versioned protocol. This separates semantic refactoring from cross-thread delivery failures and provides a rollback path that does not require reverting storage or protocol code.

Moving the current `NodeTurnRuntime` wholesale into each Worker was rejected because it would duplicate SQLite connections, integrations, tools, session state, and large caches while permitting concurrent writers.

### Keep durable state and external effects coordinator-owned

Only the coordinator may:

- reserve, append, complete, fail, interrupt, or recover turns;
- commit instruction/tool snapshots, timeline events, provider manifests, and provider-step lifecycle events;
- evaluate and resolve approvals or clarifications;
- execute tools and own shell, MCP, plugin, and hook processes;
- mutate queues, mailboxes, agent tasks, runtime leases, trust, permissions, or artifacts;
- publish gateway and TUI events.

Agent Workers own only ephemeral loop state for the active lease: the effective model-input window, provider-loop state, streamed assistant assembly, local counters, and immutable snapshot caches. Provider requests may be issued by the leased Worker only after coordinator commit acknowledgement. Provider credentials may cross only the in-memory Worker bootstrap/lease channel, must be scoped to the active job, and must never enter persisted protocol payloads, diagnostics, traces, transcript rows, or error text.

Moving provider network I/O to the coordinator was considered. It simplifies secret ownership but leaves more turn execution on the coordinator event loop and adds a second streaming broker. The first implementation keeps provider I/O in the Agent Worker while the coordinator remains the durable dispatch authority; the broker contract leaves room for a coordinator-hosted provider adapter later.

### Use a compound fencing token instead of a single version

Every job message carries a bounded envelope:

```text
protocolVersion
coordinatorEpoch
workerId + workerGeneration
leaseId + jobId
sessionId + turnId
timelineWindowId + timelineVersion
sequence
messageKind + payload
```

The coordinator creates a new random epoch on startup, increments generation whenever a Worker instance is replaced, never reuses a lease or job ID, and requires strictly increasing per-job sequence numbers. Timeline versions are monotonically increasing high-water marks; compaction or source reset creates a new timeline window identity rather than reusing an old `(window, version)` pair.

The coordinator validates the entire envelope and current lease atomically before producing a write or external effect. A content hash verifies payload equality but never replaces identity/version checks. This prevents ABA even when visible context returns to semantically identical content: `A/42 -> B/43 -> A/44` is not the original `A/42`, and a reset uses a distinct window ID.

A single integer version was rejected because Worker replacement, coordinator restart, lease reuse, compaction, and reordered delivery create distinct stale-message classes that one counter cannot safely distinguish.

### Combine exclusive leases with optimistic timeline concurrency

The pool prevents two Workers from intentionally owning one turn, while optimistic concurrency detects changes made by legitimate coordinator paths such as steering, approval, tool completion, recovery, or compaction.

Each Worker proposal names the base `(timelineWindowId, timelineVersion)`. The coordinator accepts it only when that base matches current durable state and the compound lease fence remains valid. Successful append advances the durable version and returns an acknowledgement containing the new version, request or effect identity, and logical content hash.

Conflicts before provider dispatch are resynchronized with committed deltas and recomputed. Provider requests or mutating tools are never blindly replayed after a conflict. Unconfirmed provider steps follow the existing lifecycle recovery contract; unprovable mutating effects terminalize as `effect_outcome_unknown`.

### Commit model input before provider dispatch

For every provider step:

```text
Agent Worker prepares deterministic logical input and hash
  -> coordinator independently constructs/validates canonical input
  -> coordinator atomically commits snapshots, timeline, manifest, and prepared event
  -> coordinator acknowledges request ID, version, and logical-input hash
  -> Worker verifies the acknowledgement
  -> Worker starts the provider request
```

The Worker must not dispatch when the commit fails, the lease is fenced, or hashes disagree. Dispatch start, confirmation, failure, and terminal provider lifecycle remain coordinator-persisted. This preserves the existing rule that every model-visible input is durable before it can reach a provider.

### Deliver context once, then append committed deltas

At lease bootstrap the coordinator sends the complete effective context window required by the provider, together with instruction/tool snapshot identities and hashes. During the same lease, subsequent provider steps receive only committed deltas such as assistant tool calls, bounded tool results, steering items, approval responses, or compaction window replacements.

Session restoration keeps this provider window separate from display history. With multiple durable
compaction boundaries, provider reconstruction selects the newest valid replacement and replays only
its suffix. The transcript RPC instead filters the complete append-only history so old visible turns
remain pageable through opaque SQLite sequence cursors; internal boundary replacements never become
duplicate UI messages. Pages target at most 500 projected items but keep a complete turn together,
and the TUI fetches older pages only when the viewer reaches its current top. Prepared session and
artifact snapshots retain only a bounded recent projection so `/resume` does not pin the complete
tool-heavy transcript before the client asks for it. When memory is enabled, only the latest eight
session summaries are read before the existing token budget is applied.

The Worker tracks the acknowledged timeline high-water mark and rejects gaps, duplicates, or mismatched bases. It does not read SQLite directly. On a window replacement it discards the previous conversation working set and installs the new committed bootstrap.

Immutable instruction and tool-set blobs may be cached by content hash across leases, but complete conversations may not. Cache entries and total bytes use small fixed LRU bounds. Full shell/tool output remains in coordinator-owned artifacts; the Worker receives only the bounded provider-visible projection plus an artifact reference.

Sending the complete conversation on every provider step was rejected because `postMessage` structured cloning temporarily duplicates large JavaScript object graphs and scales poorly with concurrent agents. Shared mutable memory was rejected because canonical conversation objects are complex, variable-sized, and require validation and durable ordering rather than lock-free mutation.

### Give every external attempt a durable idempotency identity

Provider steps and tool effects use coordinator-issued unique identities in addition to model-supplied call IDs. The coordinator persists started and terminal lifecycle states and deduplicates repeated requests by identity. Duplicate completed requests return the committed result; they do not repeat an effect.

On cancellation or Worker loss, read-only/cancellable work may terminalize as interrupted. A mutating effect whose completion cannot be proven terminalizes exactly once as `effect_outcome_unknown`. A new Worker receives only committed terminal results and never replays an ambiguous attempt automatically.

### Use cooperative cancellation followed by targeted hard termination

Interruption fences new requests for the target lease, sends cooperative cancel, and waits a short bounded grace period. The coordinator then cleans up owned external effects and, if the loop remains active, terminates only the leased Agent Worker. It persists exactly one interrupted turn and terminal outcome for every started tool before publishing the terminal gateway event and resolving the interrupt request.

The pool creates a replacement Worker unless shutdown or memory pressure forbids it. The outer backend supervisor remains a watchdog for a dead coordinator; its timeout must exceed the complete targeted cleanup bound and must not restart the backend for an ordinary Agent Worker interruption.

### Govern memory with elasticity, compact entrypoints, and pressure feedback

The pool starts with zero or one warm Agent Worker, grows on demand to the configured maximum, and retires idle Workers after a bounded interval. Workers use a compact entrypoint that excludes SQLite, TUI, integrations, tool implementations, and other coordinator-only modules.

Workers receive V8 `resourceLimits`, bounded protocol payloads, bounded provider/tool projections, and bounded immutable caches. They report per-isolate heap usage and event-loop utilization at safe points. The coordinator monitors process RSS and applies soft pressure by retiring idle Workers and queueing new background jobs; a hard pressure state prevents expansion and returns an explicit capacity outcome rather than silently truncating model context.

Workers are recycled while idle after a bounded number of jobs, excessive heap growth, a large-context lease, protocol failure, or configured age. Recycling never interrupts an active lease merely to reclaim memory.

### Migrate subagents before the root agent

The rollout sequence is:

1. lock existing behavior with parity and fault-injection tests;
2. extract `AgentLoop` and run it through the in-process adapter;
3. add protocol validation and the elastic single-job pool;
4. add the coordinator broker and context bootstrap/delta path;
5. migrate subagent `AgentThreadRuntimeHandle` execution;
6. add targeted child interruption and replacement;
7. migrate root turns through the same pool;
8. demote whole-backend restart to a coordinator watchdog and complete memory/crash hardening.

The implementation may select in-process or Worker-backed execution only before a turn starts. It must not silently fall back after a Worker lease begins because that would change cancellation and duplicate-effect guarantees. Rollback keeps new additive metadata readable and selects the tested in-process adapter for subsequent turns.

The compatibility environment gate applies to both lanes, while explicit root and subagent lane
overrides permit child-first and root-later rollout. The coordinator resolves the effective pair once
during backend startup, creates one shared pool when either lane is Worker-backed, and composes only
the enabled lane through a Worker adapter. Missing or blank lane overrides inherit the compatibility
gate; unknown non-blank values fail startup rather than selecting an implicit fallback.

## Risks / Trade-offs

- **The Worker protocol becomes correctness-critical** -> Use discriminated bounded schemas, strict envelope validation, sequence tests, fuzz/property tests, and default-deny handling of unknown messages.
- **Late Worker messages race with termination** -> Fence the lease before cleanup, validate epoch/generation/lease/job/turn/sequence on every message, and make terminal writes idempotent.
- **Bootstrap context still consumes memory** -> Send it once per lease, compact before bootstrap when required by normal policy, bound output projections, and retire the Worker after exceptional large-context jobs.
- **Provider credentials exist in an Agent Worker** -> Transfer only in memory for the active lease, redact every diagnostic boundary, clear job references on release, and terminate rather than reuse a Worker after protocol/security failure.
- **Coordinator brokering adds latency** -> Keep protocol payloads incremental, batch streaming deltas, and measure provider/tool step overhead against the in-process adapter.
- **Memory limits can terminate legitimate large turns** -> Use conservative soft limits, explicit capacity/backpressure states, telemetry, and normal compaction; never silently remove committed model context to satisfy a memory target.
- **A tool may finish while its Worker is terminated** -> Coordinator owns the process and lifecycle, performs bounded cleanup, and records `effect_outcome_unknown` when the result cannot be proven.
- **Staged paths may drift semantically** -> Run the same contract suite against in-process and Worker-backed adapters and compare canonical transcripts, provider manifests, lifecycle events, and usage.

## Migration Plan

1. Add adapter-neutral contracts, fixtures, protocol schemas, and baseline transcript/manifest snapshots without changing production execution.
2. Extract the Agent loop and switch current in-process execution to the new interface.
3. Implement the pool, leases, fencing validation, cancellation, replacement, memory controls, and deterministic unit tests.
4. Implement coordinator broker operations for model-input commit, provider lifecycle, tools, approvals, clarification, steering, and terminalization.
5. Enable Worker-backed subagents behind an explicit configuration gate; run concurrency, restart, mailbox, follow-up, approval, PTY, and real-provider smoke tests.
6. Make Worker-backed subagents the default after parity, retaining the in-process adapter for rollback.
7. Route root turns through the same pool, validate TUI/gateway compatibility, then narrow the outer hard-interrupt watchdog to coordinator failure.
8. Remove transitional duplicate orchestration only after both paths pass the full quality gate and operational memory/interruption evidence is captured.

Rollback switches new turns to the in-process adapter and drains active Worker leases. It does not delete durable turns, manifests, tool lifecycles, agent threads, or mailbox records. A release must not mix adapters inside one active turn.

## Open Questions

- Determine measured defaults for idle retirement, job-count recycling, V8 heap limits, RSS soft/hard pressure, and maximum protocol payload after representative macOS, Linux, and Windows profiling.
- Decide whether a later provider adapter should remain inside Agent Workers or move behind a coordinator streaming broker; the initial protocol must not make either ownership irreversible.
