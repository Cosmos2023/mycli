## Context

Background subagent state is durable in `subagent_tasks`, while parent-turn steering is durable in the existing input queue. The controller currently publishes task updates only to UI listeners. Consequently, a terminal child report is not added to the parent provider context, and the exposed `SubagentOutput` tool encourages repeated polling. `WriteStdin` is also model-visible for legitimate persistent-shell transport, so a model can misuse a sleeping shell process as an external timer.

The change spans integrations, runtime coordination, storage-backed recovery, tool exposure, and transcript projection. It must preserve the retained Python runtime, existing session data, foreground task behavior, and hidden compatibility routes.

## Goals / Non-Goals

**Goals:**

- Deliver each terminal background subagent report to its parent provider context without model polling.
- Provide a bounded `wait_agent` synchronization tool that wakes for subagent completion or user steering.
- Make delivery durable across process restart and idempotent across recovery attempts.
- Keep internal task notifications out of the user transcript while preserving visible tool lifecycle rows.
- Keep `SubagentOutput` executable through the router for compatibility but remove it from provider exposure.
- Keep `WriteStdin` limited to an existing persistent shell session.

**Non-Goals:**

- Removing the Python runtime or changing its behavior.
- Adding distributed or remote subagents.
- Changing subagent profile discovery, budgets, or child tool scopes.
- Replacing the session input queue or introducing a new external dependency.
- Guaranteeing that a subagent continues executing after the mycli process exits; abandoned running tasks remain interrupted during recovery.

## Decisions

### Use the durable input queue as the parent mailbox

Terminal controller updates will be serialized as bounded `<task-notification>` messages and enqueued with source `task_notification`. Notifications target `turn_pending`, allowing the current provider loop to consume them before its next step or the next user turn to consume them if the parent turn has already ended. The existing transactional queue commit writes the provider conversation and history together.

An in-memory-only inbox was rejected because it loses completion between process exit and the next provider step. A second mailbox table was rejected because the input queue already supplies persistence, ordering, subscription, and atomic conversation commit.

### Make notification enqueue idempotent and repairable

Each task notification uses a deterministic queue identity derived from the durable task ID. Queue enqueue checks both active queue records and committed queue identities. When a session runtime is created, it scans that session's terminal task records and ensures their notifications are queued. This repairs a crash after terminal task persistence but before notification persistence, while deterministic identities prevent duplicate provider delivery.

The task record remains the source of truth for report, status, agent profile, child session, and completion time. Notification text is derived from that record and XML-escaped before enqueue.

### Wait on queue activity rather than task status polling

`QueueCoordinator` will expose an abortable, bounded activity wait. It resolves immediately when matching pending activity already exists and otherwise subscribes until activity, abort, or timeout. `wait_agent` delegates to the owner session's queue and reports only the wake reason; the normal turn loop then commits queued inputs before the next provider request.

Long polling on `SubagentOutput` was rejected because it combines state inspection with synchronization, encourages busy polling, and cannot wake for user steering. Sleeping shell commands were rejected because they consume a process and conflate shell transport with agent coordination.

### Separate adapter routing from provider exposure

Integration registrations will carry model-visibility metadata. `Task`, `wait_agent`, and `SendMessage` remain visible. `SubagentOutput` remains registered in `ToolRouter` but is excluded from provider tool definitions. This follows the existing hidden built-in shell compatibility pattern without removing backward-compatible execution routes.

`WriteStdin` remains visible because models need it for foreground and background persistent shell sessions. Its schema and adapter continue to require a valid shell session ID; subagent waiting instructions will direct the model to `wait_agent`.

### Treat task notifications as provider-only internal input

Queue commit persists the notification as a provider conversation item with source metadata, but transcript projection suppresses user-message rows whose source is `task_notification`. `Task`, `wait_agent`, and `SendMessage` tool calls and results continue through the normal tool lifecycle and remain visible. Subagent UI update events remain bounded projections and cannot affect durable delivery.

## Risks / Trade-offs

- **Queue capacity could reject a terminal notification** -> Use bounded reports and surface enqueue failures through diagnostics; recovery retries delivery when the session is prepared again.
- **A task completes for an inactive session** -> The durable task record remains authoritative, and session preparation repairs its deterministic notification before the next turn.
- **Multiple recovery paths race to enqueue the same task** -> Deterministic queue IDs and committed-ID checks make enqueue idempotent; queue persistence remains the serialization boundary.
- **A long `wait_agent` call delays cancellation** -> The wait subscribes to the caller's `AbortSignal` and enforces schema-level minimum, maximum, and default timeouts.
- **Hiding `SubagentOutput` changes model behavior** -> The adapter remains routable for stored continuations and explicit compatibility calls; only new provider exposure changes.

## Migration Plan

1. Add visibility metadata with a default of visible so existing extension registrations remain unchanged.
2. Add deterministic task-notification enqueue and session-preparation repair without changing the queue schema.
3. Add the queue activity waiter and expose `wait_agent`.
4. Hide `SubagentOutput` from new provider requests while retaining its adapter route.
5. Suppress internal notifications in transcript projection and update documentation.

Rollback removes the new exposure and delivery wiring. Existing queued `task_notification` records remain valid internal inputs and can be safely committed or filtered by older Node code that already recognizes their source.

## Open Questions

None. Timeout bounds and notification size limits will use existing runtime limits where available and be covered by contract tests.
