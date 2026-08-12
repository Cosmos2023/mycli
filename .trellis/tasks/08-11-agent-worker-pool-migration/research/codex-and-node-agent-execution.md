# Codex and Node agent execution research

## Question

How should Node mycli map Codex's Tokio task model onto Node 24 while retaining
precise cancellation, concurrent subagents, and durable state ordering?

## Codex pattern

Source inspected at `/Users/cosmos/Downloads/codex-main`:

- Codex builds a Tokio multi-thread runtime in `codex-rs/arg0/src/lib.rs:279`.
- Each active turn is a `tokio::spawn` task with a `CancellationToken` and an
  abortable handle in `codex-rs/core/src/tasks/mod.rs:401-441`.
- Interruption cancels cooperatively, waits 100 ms, aborts only the target task,
  runs task-specific cleanup, persists the interruption marker, then emits
  `TurnAborted` in `codex-rs/core/src/tasks/mod.rs:825-895`.
- Subagents create independent logical Codex threads/sessions but still execute
  as Tokio tasks in one runtime; they are not one OS process per agent.
- Shell and sandbox work uses OS child processes and separate process cleanup.
- App-server interruption is turn-ID fenced and its request completes only
  after terminal abort handling.

## Codex `task` terminology

Codex uses several unrelated meanings of task:

- `tokio::spawn` creates an internal asynchronous Tokio task. It is scheduled
  on the runtime thread pool and is not a model-visible tool call.
- `RegularTask`, review tasks, and compact tasks are turn-execution
  abstractions. Their futures are ultimately hosted by Tokio tasks.
- `spawn_agent` creates a logical delegated subtask and child Codex session. It
  eventually causes new turn tasks, but it does not allocate one permanent OS
  thread or process per child.
- `update_plan` stores checklist/task progress for the TUI. It does not execute
  work or create concurrency.
- `spawn_agents_on_csv`, when enabled, is a durable batch-agent job feature that
  distributes input rows across agents.

The inspected Codex source does not register a model tool literally named
`task` or `Task`. A visible `Task` label is therefore an older compatibility
surface, a semantic TUI label, or checklist/subagent presentation rather than
evidence of a dedicated system thread.

## Current mycli pattern

- The TUI/supervisor is on the Node main thread and the full backend is one
  `worker_threads.Worker`.
- Root and subagent loops are Promises on the backend Worker's event loop.
- Normal interruption uses `AbortController` and durable late-write fences.
- A still-pending interruption reaches the outer supervisor after 250 ms,
  terminates the entire backend Worker, restarts it, and recovers durable
  interrupted state.
- External commands already use process-tree cleanup and should remain outside
  the Agent Worker Pool.

## Feasible approaches

### A. Reusable single-job Agent Worker Pool (recommended)

Each active turn leases one Worker. Durable state and effects stay in a
coordinator broker.

Pros:

- hard interruption is turn-scoped;
- root and subagents gain real JS parallelism;
- idle sessions do not consume threads;
- aligns with Codex task semantics without pretending a Promise is abortable.

Cons:

- requires an explicit asynchronous broker boundary;
- `NodeTurnRuntime` currently mixes orchestration, storage, tools, and execution
  and must be split;
- requires sequencing, backpressure, and crash recovery protocol work.

### B. One permanent Worker per logical agent session

Pros:

- intuitive session ownership;
- simple message targeting.

Cons:

- idle agents retain Workers and memory;
- capacity and eviction become harder;
- resident Worker state can diverge from durable session state;
- not how Tokio schedules logical sessions.

### C. Keep one backend Worker and improve cooperative cancellation

Pros:

- smallest change;
- no cross-Worker protocol.

Cons:

- no real JS parallel execution;
- an uncooperative Promise still requires whole-backend restart;
- cannot reach the requested Codex-like interruption isolation.

## Recommendation

Use approach A. Do not give Agent Workers direct SQLite access. A single writer
and effect owner keeps append-only ordering, turn identity, approval ownership,
and terminal publication auditable. Migrate subagents first, then root turns,
using the same Worker protocol and pool.
