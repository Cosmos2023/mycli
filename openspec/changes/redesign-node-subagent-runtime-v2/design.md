## Context

The current Node implementation models a subagent as a durable task record plus a process-local `ChildRuntimeHandle`. The controller can run foreground or background children, project progress and usage, automatically notify the parent on terminal completion, and wait on parent queue activity. However, a live handle exists only in an in-memory map; restart recovery interrupts abandoned work, child cancellation and close are not wired to the real runtime, optional runtime budgets are not enforced by the Node child factory, and spawn does not freeze the parent's execution authority.

The redesign must preserve the retained Python runtime, existing session data, and current automatic completion delivery. It must fit the consolidated Node backend packages, use the existing storage and input-queue abstractions where practical, and remain testable without a real provider. The design follows the semantics observed in the local Codex source snapshot: independent durable threads, canonical paths, typed communication, centralized control, context forking, and reloadable agents.

## Goals / Non-Goals

**Goals:**

- Make every child a durable, independently reloadable agent thread with its own provider history, transcript, cancellation boundary, and artifacts.
- Centralize lifecycle, capacity, authority, budget, mailbox, and recovery decisions in an `AgentSupervisor`.
- Expose a Codex-compatible agent tool surface with `spawn_agent` as the only child-spawn entry point.
- Guarantee that child authority never exceeds parent authority and that configured budgets are enforced by code.
- Deliver ordered agent messages and terminal reports durably and idempotently without model polling.
- Make lifecycle and communication behavior visible through canonical events, session artifacts, `list_agents`, and the TUI.

**Non-Goals:**

- Removing or changing the Python runtime.
- Running subagents on remote hosts or introducing a distributed queue.
- Isolating every child in an OS process or worker thread in the first implementation.
- Automatically replaying a command or mutation whose completion was not durably committed before a crash.
- Allowing an agent tree to communicate with an unrelated root session.
- Making runtime budgets mandatory; an omitted turn, tool, token, no-progress, or wall-clock budget remains unlimited.

## Decisions

### Make an agent thread the unit of execution and persistence

Every agent receives an immutable thread ID and a canonical path such as `/root/test-writer`. Display nicknames remain metadata and are never used as durable identity. Each child uses the normal session conversation, event, transcript, task, and subagent artifact pipeline rather than a reduced task-only record.

An `agent_threads` repository stores identity, canonical path, root and parent IDs, lifecycle status, frozen spawn configuration, last activity, and terminal summary. The existing `profile_id` column remains only for backward-readable storage and receives the fixed value `subagent`. An `agent_spawn_edges` repository stores topology independently from task output. Existing session history remains the source of truth for provider context; the new metadata does not duplicate conversation content.

Keeping the current task record as the primary lifecycle object was rejected because task identity, agent identity, reloadability, and multi-turn follow-up have different lifetimes.

### Put all lifecycle mutation behind AgentSupervisor

`AgentSupervisor` becomes the only service allowed to spawn, load, unload, resume, interrupt, or finalize an agent. It composes an `AgentScheduler`, `AgentMailbox`, `AgentThreadStore`, and `AgentRuntimePool`. Tool adapters, the gateway, and TUI issue commands or consume events; they do not own runtime handles.

The initial runtime pool remains in-process because agent work is provider and tool I/O bound. Logical isolation is provided by independent runtime instances, histories, abort controllers, and continuation state. A later process transport can implement the same runtime contract without changing tool semantics.

Extending `SubagentController` with additional maps was rejected because it would preserve process-local ownership and spread recovery and policy decisions across adapters.

### Reuse the durable session input queue behind a typed mailbox abstraction

`AgentMailbox` stores typed inter-agent communication in the receiver thread's durable input queue. Each item carries a receiver-local sequence, sender and receiver paths, payload, `triggerTurn`, deterministic dedupe key, source call ID, and delivery state. The abstraction supports any loaded or unloaded thread and restricts routing to one root agent tree.

`send_message` enqueues without starting a turn. `followup_task` enqueues and asks the supervisor to start a turn when the receiver is idle or unloaded. Terminal completion uses a deterministic message identity and automatic delivery to the parent. `wait_agent` subscribes to mailbox and lifecycle activity and wakes for existing activity, new mail, child completion, user steering, cancellation, or bounded timeout.

A polling result tool was rejected because it consumes provider steps, cannot wake for steering, and duplicates the durable completion channel. A separate external message broker was rejected because the local session queue already provides ordering, persistence, and transactional commit.

### Freeze spawn configuration and apply least authority

Spawn builds an immutable child configuration snapshot containing workspace root, cwd, selected environment, network and filesystem sandbox, approval policy, full-access state, model/provider selection, project instructions, the generic child instruction, tool scope, budgets, and context-fork mode.

The effective child tool and execution authority is the intersection of parent authority, platform policy, and explicit spawn restrictions. A spawn request can narrow but cannot widen parent authority. The generic child instruction is applied as a developer/system instruction layer after project instructions, not concatenated into the user task message. Runtime sandbox and approval state are reapplied to every child.

Re-resolving child policy from ambient process defaults was rejected because it can silently differ from the parent and can cause full-access children to ask for approval or restricted children to gain authority.

### Support explicit bounded context forking

`spawn_agent` accepts `fork_turns` as `none`, `all`, or a positive integer string. Forking copies only committed provider conversation items and filters transient tool transport, pending input, internal task notifications, and provider continuation identifiers that cannot be shared safely. The child then receives the spawn communication as its first independent input.

mycli defaults to `none` to prevent implicit duplication of large histories and hidden token use. Explicit calls can select `all` or last-N when the child genuinely needs prior context. The default is a product choice; the accepted modes remain compatible with Codex semantics.

### Enforce capacity and budgets in the supervisor

The scheduler atomically reserves a slot before persisting a spawn edge or starting a runtime. The initial default is four resident agents including root, with idle least-recently-used agents eligible for unload. Completed metadata does not require a resident slot. Initial maximum nesting depth is one and remains configurable.

Turn, tool-call, token, no-progress, and wall-clock budgets are checked at their real boundaries by runtime counters and deadlines. Missing limits mean unlimited, preserving the Python behavior unless explicit runtime configuration selects limits. Capacity and depth are operational limits and return typed errors instead of partially creating a child.

Checking limits only in prompts was rejected because models can ignore them and usage races can oversubscribe capacity.

### Separate safe reload from unsafe in-flight replay

Idle and unloaded agents are rehydrated from durable history and frozen configuration on demand. Runtime leases identify a process generation and last committed checkpoint. On startup, a stale running lease is inspected: work before the last committed checkpoint can be restored, but an uncommitted tool call or mutation is never automatically replayed. Such a thread becomes interrupted with a recoverable reason and remains addressable by `followup_task`.

This preserves durable agents across restart without claiming exactly-once execution for arbitrary local side effects.

### Publish one canonical lifecycle event stream

The supervisor emits typed events for reserved, spawned, loaded, started, waiting, message queued, message delivered, interrupted, unloaded, completed, and failed transitions. Storage projections, parent notifications, transcript lifecycle rows, usage views, and TUI agent trees consume these events. Provider-only mailbox payloads remain hidden from the user transcript, while all model-visible agent tool calls and results remain visible.

Direct UI callbacks from the controller are retained only as a compatibility projection during migration and are removed after consumers use canonical events.

### Keep one canonical child-spawn tool

`spawn_agent` is the only provider-visible child-spawn entry point. The transitional `Task` adapter and the legacy `SendMessage` and `SubagentOutput` adapters are removed from runtime composition and package exports; `send_message`, automatic terminal mailbox delivery, and `wait_agent` cover those workflows without polling. Existing durable task rows remain a storage projection and do not imply a provider-visible `Task` tool.

### Keep interactive child turns non-terminal

A child turn that requests command approval or user input remains active and transitions its agent thread to `waiting`. The child runtime handle stays resident, the pending request is routed by child session identity to the TUI, and the supervisor does not publish terminal task or mailbox output. Resolving the request resumes the same child runtime and turn; only completed, failed, or interrupted runtime records terminalize the task.

## Risks / Trade-offs

- **A storage migration leaves old task-only children without agent metadata** -> Synthesize terminal agent metadata and spawn edges from existing task records during read or migration; never fabricate a running runtime.
- **Mailbox delivery and completion persistence race** -> Use deterministic dedupe keys and commit terminal state plus parent notification through one storage boundary or a repairable outbox.
- **A full history fork duplicates excessive context** -> Default to `none`, expose last-N, report estimated fork size, and never copy compaction or continuation internals blindly.
- **Policy snapshots become stale after parent policy changes** -> Treat spawn authority as immutable for the child lifetime; require an explicit supervisor operation and revalidation for future policy reconfiguration.
- **In-process children can still affect shared process health** -> Bound concurrency and cancellation, isolate runtime state, and keep the runtime transport interface replaceable.
- **Unloading introduces latency on the next message** -> Retain durable mailbox ordering and load on `followup_task`; prefer idle LRU candidates only.
- **Removing `Task` breaks prompts that still call it** -> Keep durable task storage readable, update provider-visible documentation and tests, and return only the canonical `spawn_agent` definition in new requests.

## Migration Plan

1. Add core contracts, lifecycle events, durable agent metadata, spawn edges, and read-compatible migration support without changing current tool exposure.
2. Implement the supervisor, scheduler, runtime pool, and normal-session child factory behind the existing `Task` adapter.
3. Add frozen policy/config inheritance, instruction layering, context forking, real cancellation, and boundary-enforced budgets.
4. Introduce typed mailbox communication and Codex-compatible tools; route existing completion notification and `wait_agent` through the mailbox abstraction.
5. Add unload/reload, lease-based restart recovery, idempotent completion repair, and old task-record projection.
6. Switch session artifacts and TUI to canonical lifecycle events, expose `list_agents`, and validate transcript behavior.
7. Make the Codex-compatible tools the preferred provider surface, remove legacy polling/message adapters and profile discovery, and remove the old controller ownership path.

Rollback keeps the storage additions readable but switches tool composition back to the compatibility adapters and old controller. New mailbox records are ordinary typed queue inputs and must remain ignorable by older projections. No Python data or behavior is migrated.

## Open Questions

None required before implementation. Exact repository table/file layout may follow the storage package's existing backend, provided the durability, ordering, deduplication, and recovery contracts in the specs remain satisfied.
