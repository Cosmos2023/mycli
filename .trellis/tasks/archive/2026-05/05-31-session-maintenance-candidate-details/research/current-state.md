# Session Maintenance Candidate Details Research

## Current State

- `/session-maintenance` reports aggregate counts and SQLite storage counters.
- `mycli doctor` now warns when empty workspace sessions or SQLite free-list pages suggest maintenance readiness.
- The report does not identify which sessions are empty, so the user cannot inspect candidates before a future prune dry-run.
- `SessionOverview` already carries the fields needed for a bounded candidate line: `session_id`, `status`, `last_active_at`, `message_count`, and `summary_count`.

## Gap

Hermes-like local agent storage should be diagnosable enough to explain cleanup candidates. Aggregate counts say maintenance might be useful, but not which sessions need attention.

## Design Direction

Extend the read-only `SessionMaintenanceReport` with bounded `empty_session_candidates`.

Each candidate should include:

- `session_id`
- `last_active_at`
- `status`

Keep details bounded and workspace-scoped. The first version should not add stale-age policy because timestamp formats and retention policy need their own PRD.

## Relevant Specs

- `.trellis/spec/backend/database-guidelines.md`
- `.trellis/spec/backend/quality-guidelines.md`
