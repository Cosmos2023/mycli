# Doctor Session Maintenance Readiness Research

## Current State

- `DoctorService._check_sessions_db()` already opens `~/.mycli/sessions.db` in `mode=ro`.
- The existing sessions DB check fails on structural integrity issues:
  - missing required tables
  - foreign-key/orphan child rows
  - schema version mismatch
  - missing FTS/search objects
  - missing lineage parents, lineage cycles, invalid fork points
  - malformed recovery state payloads
- The previous slice added a read-only `/session-maintenance` command and a `SessionMaintenanceReport`, but doctor does not yet surface non-corrupt maintenance signals such as empty sessions or free SQLite pages.

## Gap

Hermes-like local agents should distinguish:

- corrupt or unsafe session DB state -> failed doctor check
- healthy but maintainable DB state -> warning or actionable note

Without a doctor maintenance readiness check, a long-running user has to know to run `/session-maintenance` manually.

## Design Direction

Add a read-only doctor check named `session_maintenance` after `sessions_db` succeeds. It should:

- never create or repair the DB
- never instantiate the write-path `SQLiteSessionStore`
- run only against an existing, structurally valid sessions DB
- report `ok` when there are no empty workspace sessions and no freelist pages
- report `warning` when empty workspace sessions or freelist pages exist
- include remediation pointing to `/session-maintenance`

## Relevant Specs

- `.trellis/spec/backend/database-guidelines.md`
- `.trellis/spec/backend/quality-guidelines.md`
