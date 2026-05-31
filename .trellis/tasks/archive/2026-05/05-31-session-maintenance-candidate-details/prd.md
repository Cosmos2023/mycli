# PRD: Session Maintenance Candidate Details

## Objective

Make `/session-maintenance` more actionable by showing bounded empty-session candidate details. This supports future prune/vacuum dry-run behavior while staying read-only.

## Scope

Implement:

- A typed domain payload for empty session candidates.
- `SessionMaintenanceReport.empty_session_candidates`.
- Store query that returns a bounded list of empty workspace sessions ordered by oldest `last_active_at`, then `session_id`.
- Service formatting lines:
  - `empty_candidate=<session_id> status=<status> last_active_at=<timestamp>`
  - when candidates are omitted due to limit: `empty_candidates_omitted=<n>`
- Unit tests for store and service formatting.

Do not implement:

- deletion/pruning/vacuum
- stale-age policy
- migration changes
- MCP/skills/subagent/ACP productization

## Acceptance Criteria

- Report still includes the existing aggregate fields.
- Candidate details are workspace-scoped.
- Candidate details include empty sessions only: no messages and no summaries.
- Candidate details are bounded to a small default limit.
- Omitted count is correct when empty sessions exceed the candidate limit.
- Focused tests pass:
  - `tests/unit/infrastructure/test_sqlite_session_store.py`
  - `tests/unit/services/test_session_service.py`
  - ruff on changed files

## Risks

- Ordering by timestamp string assumes the store's ISO timestamp format. This is acceptable for current `SQLiteSessionStore` timestamps but should not become a retention policy.
- The command still does not delete anything; users may expect cleanup after seeing candidates. Keep `dry_run=true` prominent.
