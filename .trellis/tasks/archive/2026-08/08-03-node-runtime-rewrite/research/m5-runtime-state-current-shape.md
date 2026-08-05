# M5 Runtime State Current Shape

## Existing Node Baseline

- `packages/storage` already owns the shared schema-v2 SQLite database and implements turn
  reservation, duplicate `client_turn_id` rejection, canonical conversation/tool persistence,
  terminal turn records, and orphaned-running-turn interruption.
- The Node store can read Python-compatible conversation and history rows, but its public
  `SessionStore` interface does not yet expose session catalog, transcript replay, generic
  session state, summaries, snapshot replacement, or durable queue/continuation operations.
- `apps/mycli/src/node-runtime/node-gateway.ts` implements a minimal `session.bootstrap`,
  `session.list`, and interruption surface. The existing Node TUI already speaks the broader
  session, queue, approval, compaction, and resume event vocabulary used by Python.
- Node provider turns already rebuild input from persisted canonical conversation items. That is
  the base for replay and compaction, not a separate implementation to replace.

## Existing Python Behavior To Port

- `services/session_service.py`, `services/session_snapshot.py`, and `services/history_replay.py`
  own session catalog/resume, bounded visible transcript projection, and replay loading. SQLite
  remains canonical; the JSON snapshot is a bounded display projection.
- `services/context/compaction/` separates trigger policy, context-only replacement, summaries,
  and bounded post-compaction rehydration. Raw durable history is retained.
- `memory/service.py` combines durable session summaries with workspace-scoped Markdown memory.
  Memory selection is bounded and must tolerate selector failure.
- `application/runtime/session_queue.py` and `user_input_mailbox.py` define session-scoped
  steering/follow-up state. Pending steers remain until a matching history commit and rejected
  steers take priority over normal follow-ups.
- Suspended approvals are durable continuation state. Resume normalizes legacy duplicate user
  messages and must not repeat an already persisted tool or provider side effect.

## Existing Contracts And Schema

- The canonical catalog already reserves `session.bootstrap`, `session.list`, `session.resume`,
  `session.tree`, `turn.steer`, queue mutation methods, `approval.respond`, compaction events,
  `session.changed`, and `turn.queue.updated`.
- Both implementations already create `sessions`, `conversation_messages`, `conversation_trees`,
  `history_items`, `turn_rollouts`, `session_state`, `session_summaries`, and `runtime_turns`.
  M5 should extend TypeScript accessors and state envelopes without a breaking schema bump.
- Persistence parity must use the four-way matrix: Python write/Python read, Python write/Node
  read, Node write/Python read, and Node write/Node read.

## Dependency Order

1. Typed session-state records and complete read/write APIs.
2. Session catalog, bounded transcript replay, resume transition, and recovery checkpoints.
3. Durable queue and steering state on those primitives.
4. Durable approval pause/resume continuation on the same checkpoint mechanism.
5. Context compaction, summaries, and bounded rehydration.
6. Workspace memory selection/injection and end-to-end recovery/parity gates.

## Main Hazards

- Queue removal before history commit can lose a steer; history commit before queue acknowledgement
  can replay it. A durable `queue_id` and idempotent reconciliation are required.
- A crash after approval but before tool-result persistence can duplicate a file mutation. The
  continuation checkpoint must distinguish approved, executing, and durably completed effects.
- Compaction must replace only provider context projection. It must not delete raw history or
  make session replay depend on a generated summary.
- Session switching must atomically replace transcript and queue/approval state so old-session
  events cannot leak into the newly active TUI session.
