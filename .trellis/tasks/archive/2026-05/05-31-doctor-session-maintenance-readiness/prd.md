# PRD: Doctor Session Maintenance Readiness

## Objective

Extend `mycli doctor` so it surfaces session maintenance candidates as actionable, read-only diagnostics. This moves the Session / State and Diagnostics foundations closer to Hermes-like operational maturity without adding destructive cleanup.

## Scope

Implement:

- A `session_maintenance` doctor check.
- The check runs read-only against an existing valid sessions DB.
- The check reports:
  - workspace-scoped session count
  - workspace-scoped empty session count
  - SQLite `freelist_count`
  - remediation text that points to `/session-maintenance`
- The check returns:
  - `ok` when no maintenance candidates are present
  - `warning` when empty sessions or free-list pages are present
- Unit tests for ok and warning cases.
- Update the database spec for the doctor maintenance readiness contract if needed.

Do not implement:

- prune/delete/vacuum
- automatic repair
- schema migration
- MCP/skills/subagent/ACP productization

## Acceptance Criteria

- Missing sessions DB continues to report only the existing `sessions_db` warning; doctor must not create the DB.
- Invalid sessions DB continues to fail `sessions_db`; `session_maintenance` must not mask structural failures.
- Valid sessions DB with no empty workspace sessions and no free-list pages reports `session_maintenance=ok`.
- Valid sessions DB with empty workspace sessions reports `session_maintenance=warning` and mentions `/session-maintenance`.
- Doctor output remains redacted and human-readable.
- Focused tests pass:
  - `uv run pytest tests/unit/services/test_doctor_service.py -q`
  - ruff on changed files.

## Risks

- `freelist_count` can vary after SQLite operations, so tests should make empty-session warning deterministic and avoid depending on exact freelist behavior.
- This check is intentionally advisory. Real cleanup still needs a separate PRD and approval.
