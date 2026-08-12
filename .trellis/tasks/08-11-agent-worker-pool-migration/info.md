# Technical Design Notes

## Proposed data flow

```text
TUI
  -> gateway turn.submit
  -> coordinator reserves durable turn
  -> coordinator leases idle Agent Worker
  -> Worker starts AgentLoop(job identity, immutable turn input)
  -> Worker requests provider-step commit
  -> coordinator persists model input and acknowledges
  -> Worker calls provider and streams validated deltas
  -> Worker requests tool execution
  -> coordinator owns approval, process/tool execution, and persistence
  -> tool result returns to Worker
  -> Worker reaches terminal outcome
  -> coordinator persists terminal state and snapshot
  -> coordinator publishes terminal gateway event
  -> coordinator releases Worker lease
```

## Worker lease identity

Every job message must contain:

- protocol version;
- worker ID and Worker generation;
- job ID;
- session ID and turn ID;
- monotonic message sequence;
- message kind and bounded structured payload.

The coordinator validates identity and sequence before side effects. Releasing
or terminating a lease fences its generation before terminal persistence.

## Interruption sequence

```text
interrupt(turn_id)
  -> validate active lease
  -> fence new provider/tool requests
  -> send cooperative cancel
  -> wait 100 ms
  -> request owned external-effect cleanup
  -> terminate target Worker if still active
  -> close pending tool lifecycles
  -> persist interrupted turn and terminal snapshot
  -> publish terminal event
  -> resolve interrupt RPC
  -> create replacement Worker
```

The outer backend supervisor timeout must exceed the bounded targeted cleanup
path. It remains responsible for a dead coordinator, not an ordinary blocked
agent job.

## Pool policy

- One active job per Worker.
- Capacity defaults to the configured logical agent capacity.
- Interactive root work has priority over background child work.
- FIFO order is preserved inside a priority class.
- Idle logical sessions do not retain a Worker.
- Worker failures always create a replacement unless shutdown is in progress.
- The pool has bounded queued jobs and bounded startup/shutdown timeouts.

## pi-agent comparison

pi-agent's core runs one active agent Promise on the main JavaScript event loop
and uses `AbortController` for cooperative cancellation. Its official subagent
example obtains isolation by spawning a complete `pi` OS process per delegated
task, with four-way bounded concurrency and JSONL progress streaming.

mycli should adopt that example's isolated context, strict structured progress,
bounded result, concurrency-limit, and per-child usage patterns. It should not
adopt process-per-subagent as the default because mycli has shared durable
sessions, approvals, mailboxes, tool ownership, and append-only ordering. Those
remain coordinator-owned while reusable Agent Workers host only active loops.

## Migration boundaries

### In-process extraction

First extract a transport-neutral `AgentLoop` and keep behavior behind an
in-process adapter. This isolates lifecycle refactoring from Worker transport
bugs.

### Subagents first

Implement a Worker-backed `AgentThreadRuntimeHandle`. Keep logical resident
state, mailbox state, usage, task records, and scheduling in `AgentSupervisor`.
Only the active `run` / `runMailbox` execution obtains a Worker lease.

### Root second

After child parity, route gateway root turns through the same pool while keeping
strict turn ID fencing and terminal-event-before-RPC-response semantics.

## Persistence rules

- Coordinator is the only SQLite owner.
- Worker cannot directly reserve, append, complete, fail, or recover a turn.
- Provider input commit is acknowledged before network submission.
- Terminal state is committed before terminal publication.
- Pending tools close before the terminal turn transition.
- Late or duplicate messages are observable diagnostics only and never repair
  active canonical state.

## Error categories

- `agent_cancelled`: cooperative user cancellation.
- `agent_worker_terminated`: targeted hard cancellation.
- `agent_worker_crashed`: abnormal Worker exit.
- `agent_worker_protocol_error`: malformed or stale Worker message.
- `agent_pool_capacity`: bounded queue/capacity rejection.
- `coordinator_restarted`: outer supervisor disaster recovery.

These names are provisional and must align with existing runtime error enums
before implementation.

## Small-PR delivery plan

1. Baseline contracts and fixtures.
2. AgentLoop extraction with in-process parity.
3. Worker protocol and coordinator broker.
4. Worker Pool implementation.
5. Subagent migration and concurrency tests.
6. Root migration and TUI/gateway parity.
7. Targeted interruption and outer watchdog adjustment.
8. Crash recovery, diagnostics, platform tests, docs, and cleanup.
