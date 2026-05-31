# PRD: Multi-child Resume Tip Determinism

## Summary

Lock the automatic root-to-tip resume selection when a session has multiple child branches.

## Requirements

1. Store tests prove `resolve_resume_session_id(parent)` chooses the child with the newest `last_active_at`.
2. Store tests prove `updated_at` is used when `last_active_at` ties.
3. Store tests prove `session_id DESC` is used when timestamps tie.
4. Service tests prove `resume_conversation(root)` returns the selected branch lineage, not an arbitrary sibling.
5. Database guidelines document this ordering contract.

## Non-goals

- Do not add branch selection UI.
- Do not change session/fork command UX.
- Do not productize MCP, skills, subagent/multi-agent, or ACP.
- Do not merge to `main`.

## Acceptance

- `uv run pytest tests/unit/infrastructure/test_sqlite_session_store.py tests/unit/services/test_session_service.py -q` passes.
- `uv run ruff check src/mycli/infrastructure/sqlite_session_store.py tests/unit/infrastructure/test_sqlite_session_store.py tests/unit/services/test_session_service.py` passes.
- Trellis task is archived and the slice is committed on the feature branch only.
