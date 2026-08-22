## Context

`sessions.db` is authoritative for session recovery, provider replay, readable transcript projection, and search. The current schema stores canonical conversation/history JSON and also lets two FTS5 virtual tables retain their own searchable content. Older rollout rows additionally contain full event arrays, while some obsolete terminal continuation snapshots remain in `session_state`. On the inspected database these historical representations dominate file size, but rollout events still have one live read-time responsibility: an `approval_resolution` marker suppresses a duplicate legacy user message in readable transcript projection.

The worktree already contains schema version 8 changes for the agent worker pool. This change must build on those edits without reverting them, keep multi-process writes behind `SQLiteSessionStore.#write`, and preserve existing public transcript/provider behavior.

## Goals / Non-Goals

**Goals:**

- Stop FTS from storing a second full copy of conversation JSON.
- Remove the unused history-item FTS projection.
- Report the count and logical bytes of safely compactable legacy payloads without loading all payloads into application memory.
- Explicitly compact terminal legacy rollout events while retaining the minimal approval marker required by readable transcript projection.
- Explicitly delete obsolete terminal `turn_record` and unused `provider_timeline` state only when the session has no active turn or approval/clarification continuation.
- Make schema migration and maintenance retry-safe and observable.

**Non-Goals:**

- Merging `conversation_messages` and `history_items`.
- Compressing blobs or changing provider request manifests.
- Deleting canonical transcript, summaries, compact boundaries, provider ledger rows, active recovery state, or whole non-empty sessions.
- Automatically running payload cleanup or `VACUUM` during startup.
- Adding age-, count-, or size-based session retention.

## Decisions

### Use FTS5 external-content indexing for conversation search

Schema version 9 will recreate `conversation_messages_fts` with `content='conversation_messages'` and `content_rowid='rowid'`. Its indexed text column will map directly to `conversation_messages.payload_json`; unindexed identity columns retain the existing join contract. Insert, update, and delete triggers will use the documented external-content maintenance protocol, and migration will rebuild the index from the canonical table.

External-content FTS is preferred over a pure contentless table because it avoids the duplicated FTS content table while retaining normal row lookup and well-defined update/delete behavior. Keeping the current content-bearing FTS layout was rejected because it is responsible for tens of megabytes of avoidable duplication.

### Remove `history_items_fts`

No production search path queries `history_items_fts`; session search uses `conversation_messages_fts`, while readable transcript projection reads indexed `history_items` rows directly. Schema version 9 will drop the unused virtual table and its triggers. Reintroducing a second contentless index was rejected because it would retain write/index amplification without a consumer.

### Separate automatic schema migration from destructive payload maintenance

FTS recreation is a derivable-index migration and can run automatically in the existing schema transaction. Rollout/state compaction changes durable historical payloads and will run only through a new explicit `/session maintenance --apply-payloads` action. The ordinary maintenance report remains dry-run and exposes eligible row counts plus estimated logical bytes removable.

This separation makes an application upgrade reversible by restoring the database backup and avoids silently discarding diagnostic history at startup.

### Compact only terminal rollout event arrays and retain an approval sentinel

A rollout is eligible only when its JSON is valid, has a non-empty event array, has a terminal status (`completed`, `failed`, `interrupted`, or `rejected`), and its session has no `in_progress` runtime turn, pending decision, or suspended turn. Compaction preserves all top-level rollout fields and replaces `events` with either an empty array or one minimal `turn_item` whose payload type is `approval_resolution`.

The sentinel is required because `projectTranscript` uses its presence to suppress a duplicate user message produced by legacy approval resume. Copying complete approval events was rejected because the projector only consumes the marker and their remaining metadata contributes unnecessary size.

### Delete only demonstrably inactive legacy state

The payload maintenance action deletes:

- `turn_record` rows whose embedded status is terminal; and
- `provider_timeline` rows, which have no current runtime reader after provider timeline persistence moved to the model-input ledger.

Both are eligible only when their session has no `in_progress` runtime turn and no `pending_decision` or `suspended_turn`. `responses_continuation_state`, `compact_checkpoint`, active approval/clarification records, input queues, and other state keys remain untouched.

### Report logical savings separately from physical file size

Maintenance reports estimate removable payload bytes from SQLite JSON expressions. Apply results report the actual reduction in stored payload character bytes. They do not claim that the database file immediately shrank; deleted/freed pages are reusable and `/session maintenance --apply-vacuum` remains the explicit physical compaction step.

## Risks / Trade-offs

- **FTS migration temporarily performs index rebuild work** -> Run inside the existing `BEGIN IMMEDIATE` schema migration transaction, test rollback/retry, and do not combine it with `VACUUM`.
- **External-content index can drift from its canonical table** -> Maintain it through triggers and add doctor/integrity checks plus insert/update/delete/search regression tests.
- **Legacy rollout fields may be malformed** -> Eligibility requires valid JSON and expected event/status shapes; unrecognized rows are skipped.
- **Approval transcript suppression could regress** -> Preserve the minimal approval sentinel and compare readable transcript output before and after maintenance.
- **Maintenance can increase WAL/freelist before shrinking the file** -> Report logical savings accurately, document the separate vacuum action, and retain bounded SQLite busy handling.
- **Existing worktree schema changes overlap this work** -> Introduce schema version 9 additively on top of version 8 and update existing migration tests rather than replacing worker-pool tables or indexes.

## Migration Plan

1. Back up `sessions.db` before testing against user data.
2. Opening schema versions 2 through 8 runs the version 9 transaction: drop old FTS triggers/tables, create external-content conversation FTS, rebuild it, recreate compatibility indexes, and update `schema_version` last.
3. A failed transaction rolls back to the previous version and is safe to retry on the next open.
4. Run `/session maintenance` to inspect eligible rollout/state counts and estimated logical savings.
5. Run `/session maintenance --apply-payloads` explicitly to compact eligible payloads; the operation is idempotent.
6. Verify `/resume` and `/session search`, then optionally run `/session maintenance --apply-vacuum` to reduce the physical database file.

Rollback requires restoring the pre-migration database backup; older binaries must not open schema version 9.

## Open Questions

None for phase one. Blob compression, canonical transcript normalization, provider-ledger retention, and automatic session retention remain separate future changes.
