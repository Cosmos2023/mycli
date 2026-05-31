# Doctor Session Schema Search Diagnostics

## Problem

The session DB doctor check can report `sessions_db=ok` even when
`schema_version` or local search FTS objects are missing/stale. These objects
are part of the session/search foundation and should be diagnosable without
mutating the database.

## Scope

In scope:

- Add read-only doctor validation for `schema_version`.
- Add read-only doctor validation for required session search FTS table and
  triggers.
- Add doctor unit tests for stale/missing schema/search objects.
- Keep existing healthy DB and lineage/recovery diagnostics intact.

Out of scope:

- Repairing, migrating, vacuuming, or pruning the session DB.
- Changing `SQLiteSessionStore` write/migration behavior.
- Productizing MCP, skills, subagent/multi-agent, or ACP.

## Requirements

- Healthy DBs created by the test helper and by `SQLiteSessionStore` must pass
  `sessions_db`.
- Missing `schema_version` must fail `sessions_db` with an actionable bounded
  message.
- Stale `schema_version` must fail `sessions_db` with expected/current version
  detail.
- Missing FTS search table or triggers must fail `sessions_db` with bounded
  object names.
- Doctor must not create missing FTS/search objects while checking.

## Acceptance Criteria

- New unit tests cover missing schema version, stale schema version, and missing
  search objects.
- `uv run pytest tests/unit/services/test_doctor_service.py -q` passes.
- `uv run ruff check src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py` passes.
- Trellis task is archived and committed.
