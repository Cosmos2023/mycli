# Current State

## Existing Behavior

- `/session-maintenance` is read-only and reports workspace sessions,
  empty-session candidates, database size, page count, freelist count, and page
  size.
- `/session-maintenance --apply-empty` deletes bounded empty-session candidates
  after recomputing them at execution time.
- `/session-maintenance --apply-orphans` deletes orphan child rows from known
  session child tables.
- Doctor can warn when `freelist_count` suggests maintenance would be useful,
  but there is no explicit command to reclaim free SQLite pages.

## Gap

Hermes-like long-running local agents need durable session stores that can be
maintained without manual SQLite commands. `mycli` can now prune empty sessions
and orphan rows explicitly, but it still cannot run an explicit storage vacuum
when freelist pages accumulate.

## Chosen Slice

Add `/session-maintenance --apply-vacuum` as a separate explicit maintenance
operation. Keep the default report and doctor read-only; do not run vacuum from
doctor or from cleanup commands. Return bounded before/after storage counters so
the action is diagnosable and testable.
