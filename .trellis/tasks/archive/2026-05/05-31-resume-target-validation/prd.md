# PRD: Resume Target Validation

## Summary

Harden session resume so missing session ids fail explicitly instead of returning an empty conversation, while preserving legacy message-only session recovery.

## Requirements

1. `SQLiteSessionStore.resolve_resume_session_id("missing")` raises a clear `ValueError` when no session, tree, or message rows exist for the requested id.
2. `SQLiteSessionStore.load_conversation_lineage("missing")` raises the same class of error instead of returning an empty lineage.
3. `SessionService.resume_conversation("missing")` propagates the error instead of returning an empty `Conversation`.
4. Legacy sessions with `sessions` and `conversation_messages` rows but no `conversation_trees` metadata still resume successfully.
5. Existing root-to-tip descendant resume behavior remains unchanged.

## Non-goals

- Do not implement session repair or deletion.
- Do not change the user-facing `/resume` command copy beyond existing error propagation.
- Do not productize MCP, skills, subagent/multi-agent, or ACP.
- Do not merge to `main`.

## Acceptance

- `uv run pytest tests/unit/infrastructure/test_sqlite_session_store.py tests/unit/services/test_session_service.py -q` passes.
- `uv run ruff check src/mycli/infrastructure/sqlite_session_store.py tests/unit/infrastructure/test_sqlite_session_store.py tests/unit/services/test_session_service.py` passes.
- Trellis task is archived and the slice is committed on the feature branch only.
