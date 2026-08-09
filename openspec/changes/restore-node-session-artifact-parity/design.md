## Context

The Node runtime uses `sessions.db` for canonical conversation, history, shell snapshots, input
queues, and subagent task records. `TranscriptSnapshotStore` currently writes only a schema-v2
`session.json`. The retained Python runtime additionally writes session-scoped readable artifacts:
`events.jsonl`, `tasks/<task-id>/output.txt`, and `subagents/<run-id>.json`; its parent snapshot also
contains a subagent index.

The projection spans storage paths, atomic file replacement, terminal runtime callbacks, shell
lifecycle accumulation, subagent lifecycle delivery, restart repair, and transcript snapshot
parsing. Existing Python directories and Node schema-v2 degraded recovery must remain readable.

## Goals / Non-Goals

**Goals:**

- Restore the Python-compatible session artifact layout for Node-created sessions.
- Keep session artifacts derivable from canonical SQLite records.
- Ensure terminal subagent task notifications reference a readable task output file.
- Serialize competing snapshot projections and drain them before backend shutdown.
- Preserve bounded, validated, private file writes and focused recovery behavior.

**Non-Goals:**

- Replacing SQLite with JSON or JSONL files as the recovery authority.
- Migrating `session.json` from the established Node schema version 2 to Python schema version 3.
- Reconstructing shell output that was already omitted by the bounded canonical shell snapshot.
- Backfilling every historical Python event type from existing SQLite rows.

## Decisions

### Add a dedicated storage-layer artifact projector

A `SessionArtifactStore` will own validated paths, append-only event rows, atomic task output files,
deterministic subagent snapshot names, and subagent index projection. Shared session-path validation
will be used by both it and `TranscriptSnapshotStore`.

Putting this logic directly in the backend was rejected because path validation and atomic file
replacement are storage concerns. Reusing `TranscriptSnapshotStore` for unrelated task and event
files was rejected because it would blur transcript recovery with auxiliary artifact projection.

### Keep schema-v2 snapshots and add validated optional metadata

Node `session.json` keeps `schema_version: 2` and its existing scalar `state`. Optional `subagents`
and `links.events` fields are added and sanitized during degraded reads. This retains existing Node
recovery behavior while restoring the parent-session navigation surface used by Python snapshots.

Upgrading the entire snapshot to Python schema v3 was rejected because its state and lineage shape
differs from the established Node degraded-recovery contract and is unnecessary for this fix.

### Derive subagent artifacts from durable task and child-history records

Subagent task payloads gain optional bounded `mode` and `description` metadata without changing the
SQLite table. A deterministic `subagent-<sha256-prefix>.json` file is written under the parent
session using the durable task record plus the child session's canonical history. Terminal reports
are also written to `tasks/<child-session-id>/output.txt`.

The live controller event triggers prompt projection, and session preparation repairs files from
durable task records after restart. The task row remains authoritative if a file write fails.

### Project shell task output from the existing lifecycle accumulator

`ShellLifecycleProjector` already owns the bounded accumulated shell output. On terminal background
shell completion it invokes an optional task-output projection callback after the canonical shell
snapshot is persisted. Foreground commands do not create task directories.

### Serialize backend artifact work and contain auxiliary failures

The backend uses one promise chain for session snapshot, event, and subagent artifact operations.
The chain is drained before the SQLite store closes. `session.json` keeps its existing terminal
snapshot failure semantics; auxiliary `events.jsonl`, `tasks/`, and `subagents/` failures are
contained and retried from durable records during later preparation where possible.

`events.jsonl` receives `conversation.saved` after terminal session snapshot projection and
`subagent.updated` after a subagent snapshot update. Restart repair does not invent historical event
rows.

## Risks / Trade-offs

- **Artifact writes race with parent terminal snapshots** -> Serialize all backend session artifact
  work and build each snapshot from current SQLite state.
- **Process exits after SQLite commit but before file projection** -> Repair subagent/task files and
  rebuild `session.json` from SQLite when the session is prepared again.
- **Shell output was already truncated in canonical storage** -> Write the retained bounded output
  and preserve omission information in SQLite; do not claim unavailable bytes were recovered.
- **Malformed existing artifact files** -> Replace deterministic JSON/output targets atomically;
  append events as complete JSONL rows without using them for provider recovery.
- **Large child histories produce large readable snapshots** -> Reuse canonical bounded history
  records and private local files; no provider request includes these snapshots.

## Migration Plan

1. Add storage projection types and tests without changing runtime behavior.
2. Persist additive subagent mode/description metadata for new task records.
3. Wire terminal snapshots, subagent updates/recovery, and background shell completion.
4. On the next session preparation, reconstruct missing subagent/task files and rewrite the parent
   snapshot index from SQLite.

Rollback removes the new projection calls and optional snapshot fields. Existing additive files are
safe to leave in place, and SQLite remains sufficient for Node recovery.

## Open Questions

None. Historical non-subagent event backfill and full unbounded shell-output archival remain outside
this compatibility fix.
