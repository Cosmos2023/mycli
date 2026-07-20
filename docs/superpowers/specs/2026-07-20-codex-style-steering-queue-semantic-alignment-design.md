# Codex-Style Steering Queue Semantic Alignment

## Status

Approved on 2026-07-20.

This design upgrades the queue behavior described in
`2026-07-11-codex-style-steering-queue-design.md`. The earlier document remains
the record for the first TUI preview and edit-last implementation. This document
defines the authoritative backend state machine, delivery acknowledgement,
session isolation, persistence, and the three Codex-style visible queue classes.

## Goal

Make mycli's steering and follow-up behavior semantically equivalent to Codex
while preserving mycli's backend-first architecture. The backend owns queue
truth. The Node TUI and future clients project that state and request operations;
they do not maintain an independent delivery queue.

The completed system must provide these guarantees:

- A steering input targets one known active turn.
- A steer is not removed from pending state until it is committed to turn
  history.
- A steer rejected by a non-steerable or changed turn is retained for the end of
  the turn.
- Rejected steers run before ordinary follow-up inputs.
- Queue operations are idempotent across retries and lost RPC responses.
- Queues are isolated by session and survive process restart and `/resume`.
- TUI previews are a projection of backend snapshots and events.

## Non-Goals

- Replacing the existing conversation or turn persistence model.
- Persisting internal TUI layout state in the queue record.
- Adding arbitrary queue reordering in the first implementation.
- Making an in-flight provider request mutable. Steering becomes model-visible
  at the next safe request boundary.
- Rendering internal task-notification XML in the visible queue preview.

## Current Problems

The current runtime stores two process-local lists:

- `steering`
- `follow_up`

That implementation can consume steering before the next model request and
follow-ups after an answer, but it lacks the state needed to distinguish:

- a steer accepted for the active turn but not yet committed;
- a steer that could not be delivered to the requested turn;
- an ordinary next-turn input.

The lists are not session-scoped persisted state. `client_turn_id` is carried as
metadata but is not an idempotency key. The Node gateway also has local fallback
arrays, so an ambiguous RPC failure can produce an unseen or duplicate retry.

## Architecture

### Backend Queue Coordinator

Introduce a session-scoped queue coordinator in the application/runtime
boundary. `AgentRuntime` uses the coordinator instead of owning raw queue lists.
The coordinator is the only component allowed to create, transition, remove, or
restore queued input records.

The coordinator exposes atomic operations:

- enqueue a steer for an expected active turn;
- enqueue an ordinary follow-up;
- mark a steer committed to history;
- reject a steer for end-of-turn delivery;
- consume the next rejected steer or follow-up;
- pop the latest editable follow-up;
- snapshot, clear, persist, and restore one session queue.

Every mutation returns the complete queue snapshot and a monotonic revision.

### Runtime Integration

`TurnExecutor` asks the coordinator for pending steers at each model request
boundary. It appends accepted records to the conversation and turn history, then
acknowledges those exact queue IDs as committed. Queue removal and history append
must be ordered so a crash cannot silently lose an uncommitted steer.

The service mints a server `turn_id` before starting the worker. That ID is passed
into `AgentRuntime`, emitted by `turn.started`, and used as the steering target.
`client_turn_id` remains the idempotency/correlation ID supplied by the client;
the two IDs must not be treated as interchangeable.

At terminal turn completion, scheduling order is:

1. rejected steers, FIFO;
2. ordinary follow-ups, FIFO.

Exactly one record starts the next turn. Remaining records stay queued.

### Gateway Integration

The gateway validates `expected_turn_id` while holding its turn lock and delegates
all queue mutations to the coordinator. It returns an explicit disposition:

- `accepted_for_turn`
- `deferred_to_end_of_turn`
- `queued_follow_up`
- `duplicate`

The Node TUI replaces its local delivery arrays with the latest backend snapshot.
It may render an ephemeral submitting state for the current RPC, but it must not
create a durable local fallback record after an ambiguous failure.

## Domain Model

### Queued Input Record

Each persisted record contains:

```text
queue_id: stable server ID
session_id: owning session
client_turn_id: client idempotency key
target_turn_id: expected active turn for a steer, otherwise null
kind: pending_steer | rejected_steer | follow_up
delivery_state: queued | accepted | committed
text: normalized message text
image_paths: ordered unique local image paths
source: user | task_notification | runtime
created_at: UTC timestamp
updated_at: UTC timestamp
```

`queue_id` identifies server state transitions. `(session_id, client_turn_id)` is
the idempotency key for client submission. Repeating a request with the same key
returns the existing record and does not enqueue another copy.

`committed` is a terminal acknowledgement state used for the atomic persistence
transition. Committed records do not appear in active snapshots and may be
deleted after the commit transaction is durable.

### Queue Snapshot

```text
session_id
revision
pending_steers[]
rejected_steers[]
follow_ups[]
activity
```

`revision` increases on every mutation. Clients ignore snapshots older than the
latest applied revision.

Activity counts exclude internal task notifications from user-visible counts but
retain them in backend snapshots used by the runtime.

## State Transitions

### Steering Submission

1. TUI submits `turn.steer` with `client_turn_id` and `expected_turn_id`.
2. Gateway checks the active turn under the same lock used by turn lifecycle
   updates.
3. If the expected regular turn is active and steerable, create
   `pending_steer/accepted`.
4. If a turn is active but its ID differs or its mode is not steerable, create
   `rejected_steer/queued`.
5. If no turn is active because completion raced with submission, create a
   `rejected_steer/queued` record so it retains priority over ordinary follow-up.
6. Emit `turn.queue.updated` with the new revision and snapshot.

### Safe-Boundary Commit

1. Before a model request, claim all pending steers targeting the current turn.
2. Append each record as a separate user message, preserving images and source.
3. Append the corresponding user-message `TurnItem` with `queue_id` metadata.
4. Persist the history append.
5. Mark the claimed queue IDs committed and remove them from the active snapshot.
6. Emit the updated queue revision.

A provider request already in flight is never modified. A pending steer remains
visible until this commit sequence completes.

History persistence and structured queue state do not currently share one
database transaction. Recovery therefore treats a history item carrying a
`queue_id` as the commit record: if history contains that ID while queue state
still lists it as pending, startup marks it committed without delivering it
again. If history does not contain the ID, the record remains pending or is
converted to rejected according to turn state.

### Turn Completion

After a terminal completion, interruption, or failure:

1. Any pending steer still targeting the completed turn becomes rejected.
2. Select the oldest rejected steer; if none exists, select the oldest follow-up.
3. Start exactly one new turn from that record.
4. Remove it only after the new turn submission is accepted.

Approval and clarification states retain the queue. Automatic draining waits
until the pending decision is resolved.

### Interrupt

Manual interrupt does not clear queue state. Pending steers remain visible during
interrupt handling. When the old turn reaches its terminal state, they transition
to rejected steers and are submitted before ordinary follow-ups.

### Edit Last Follow-Up

`turn.queue.pop` removes only the newest ordinary follow-up and returns its text,
images, source, IDs, and the remaining snapshot. Pending and rejected steers are
not editable through this operation.

## Persistence And Resume

Store the queue snapshot as structured session state under a dedicated key. Every
mutation persists before its event is emitted.

On runtime construction or session rebind:

1. load the target session queue;
2. validate and normalize records;
3. convert pending steers targeting a non-active historical turn to rejected
   steers;
4. expose the restored snapshot through bootstrap/status;
5. schedule the next eligible record only after session resume completes.

Switching sessions swaps coordinators or coordinator scope atomically. Records
from the previous session must never appear in the new session status or TUI.

The readable `session.json` remains a transcript snapshot and does not duplicate
the operational queue payload. Canonical structured session state owns recovery.

## Gateway Contract

### Requests

`turn.steer` adds:

```text
message
client_turn_id
expected_turn_id
local_images[]
```

`turn.submit` and `turn.started` expose the server `turn_id` independently from
`client_turn_id`. The TUI stores the active server ID and sends it as
`expected_turn_id` for steering.

`turn.follow_up` continues to accept message, client ID, and attachments.

`turn.queue.pop` remains edit-last-follow-up. `turn.queue.clear` remains a
compatibility/admin operation and returns the records it removed.

### Responses And Events

Queue mutation responses and `turn.queue.updated` contain:

```text
accepted
disposition
queue_revision
queue_items {
  pending_steers[]
  rejected_steers[]
  follow_ups[]
}
activity
```

Legacy `steering`, `follow_up`, `steering_items`, and `follow_up_items` fields are
retained during migration. They are projections of the authoritative snapshot;
clients must not combine legacy and structured arrays.

Gateway error schemas add explicit stale-turn and invalid-queue-transition codes.
An idempotent duplicate is a successful response with disposition `duplicate`,
not an error.

## TUI Behavior

The TUI projects the three visible sections in this order:

```text
• Messages to be submitted after next tool call
  (press esc to interrupt and send immediately)
  ↳ Check the latest command output.

• Messages to be submitted at end of turn
  ↳ Retry this after the current turn.

• Queued follow-up inputs
  ↳ Summarize after completion.
    alt+up edit last queued message
```

Display rules:

- Pending steers, rejected steers, and follow-ups remain visually distinct.
- Internal task notifications are omitted from visible sections and counts.
- Image-bearing input shows an attachment marker even if the text has no image
  placeholder.
- The displayed interrupt and edit hints use the active keybinding map.
- Each item remains bounded by a visual-line limit.
- The entire preview has a terminal-height budget. Overflow ends with
  `... +N more` rather than shrinking the transcript below its minimum useful
  height.
- Newer queue revisions update the preview immediately; older revisions are
  ignored.
- Queue state is cleared from the TUI during a session transition and replaced
  by the destination session snapshot.

## Compatibility And Migration

Migration is staged but preserves one source of truth throughout:

1. Add the new domain records, coordinator, persistence, and compatibility
   snapshot projections.
2. Move `AgentRuntime` and `TurnExecutor` consumption to the coordinator.
3. Upgrade gateway schemas and expected-turn validation.
4. Replace Node local fallback arrays with revisioned backend snapshots.
5. Add the rejected-steer TUI section and bounded presentation.
6. Remove legacy internal list ownership after all callers use the coordinator.

Existing callers of `queue_steering_message`, `queue_follow_up_message`,
`queued_messages`, and `queued_input_items` receive compatibility projections
until their tests and integrations migrate.

Existing in-memory queues present during a process upgrade cannot be recovered.
Persisted queue state begins with the first version containing this design.

## Error Handling

- Blank input is rejected before queue mutation.
- A duplicate idempotency key with different content is an explicit conflict.
- Invalid persisted records are quarantined from active delivery and recorded in
  diagnostics; valid records continue loading.
- A failed persistence write aborts the mutation and event emission.
- A failed history commit leaves the steer pending for retry.
- A failed next-turn submission leaves the rejected steer or follow-up queued.
- A malformed or stale TUI snapshot cannot lower the latest queue revision.
- Queue mutation and turn lifecycle locks must have one documented acquisition
  order to avoid deadlock.

## Capacity And Backpressure

The coordinator enforces configurable safety limits with these defaults:

- 128 active records per session;
- 64 KiB UTF-8 text per record;
- 512 KiB aggregate active UTF-8 text per session;
- 16 attachments per record.

Internal task notifications use the same aggregate budget. When capacity is
exceeded, user submissions receive a structured error. Internal sources emit a
diagnostic and retain a bounded latest notification rather than growing without
limit.

## Testing

### Domain And Persistence

- Valid state transitions and invalid-transition rejection.
- FIFO ordering within each class and rejected-before-follow-up priority.
- Idempotent duplicate submission and conflicting duplicate detection.
- Session isolation, save/load, restart, and resume normalization.
- Capacity limits and persistence failure behavior.

### Runtime

- Pending steer remains visible until history commit.
- Safe-boundary commit preserves text, images, source, and queue ID.
- In-flight requests are not mutated.
- Pending steers become rejected on completion, interruption, and failure.
- Exactly one end-of-turn record starts the next turn.
- Approval and clarification retain queues.

### Gateway

- Expected-turn validation is race-safe.
- Mutation responses and events carry matching revisions and snapshots.
- Lost-response retry returns `duplicate` without a second record.
- Bootstrap/status and session resume expose only the active session queue.
- Legacy projections match structured queue items during migration.

### TUI

- All three sections render in priority order.
- Queue events dynamically add, transition, and remove previews.
- Stale revisions are ignored.
- Attachments and remapped keybindings are visible.
- Internal notifications remain hidden.
- Narrow widths, short terminals, CJK, multiline input, and overflow are bounded.
- Session switching clears the old queue before rendering the new snapshot.
- Streaming token updates do not rebuild unchanged queue chrome.

### End-To-End

- Submit a steer during model streaming and observe it until safe-boundary commit.
- Reject a steer against a non-steerable or stale turn and run it before a
  follow-up.
- Retry an ambiguous steer RPC without duplication.
- Interrupt with pending steers and verify priority resubmission.
- Restart and resume a session with all queue classes present.

## Acceptance Criteria

- Backend queue state is authoritative, session-scoped, persisted, and
  revisioned.
- Steering submission targets an expected turn and has an explicit disposition.
- Pending steers disappear only after durable history commit.
- Rejected steers are visible and run before follow-ups.
- RPC retries do not duplicate input.
- `/resume` restores the correct session queue without cross-session leakage.
- The TUI renders all queue classes immediately and within terminal bounds.
- Legacy clients remain functional during the migration period.
- Existing turn execution, approvals, clarifications, background notifications,
  transcript replay, and streaming performance tests remain green.
