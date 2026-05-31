# PRD: Session Lineage Recovery Hardening

## Summary

Make session lineage corruption easier to detect before runtime resume. Specifically, doctor must detect child fork points that refer beyond the parent transcript, and the store must have regression coverage for the same failure mode.

## Requirements

1. Add a regression test proving `SQLiteSessionStore.load_conversation_lineage()` rejects a child `fork_point` that exceeds the parent message count.
2. Update doctor session DB integrity checks so `sessions_db=failed` reports invalid fork points when a child `fork_point` is larger than the parent conversation message count.
3. Preserve the existing doctor checks for:
   - orphan child rows
   - missing lineage parents
   - lineage cycles
   - child-local invalid fork points
   - malformed recovery state payloads
4. Keep doctor read-only. It must not instantiate the write-path store, repair rows, delete rows, or run vacuum.
5. Update database guidelines to document parent-message fork-point validation.

## Non-goals

- Do not implement destructive cleanup or repair.
- Do not change resume/fork product UX.
- Do not productize MCP, skills, subagent/multi-agent, or ACP.
- Do not merge to `main`.

## Acceptance

- `uv run pytest tests/unit/infrastructure/test_sqlite_session_store.py tests/unit/services/test_doctor_service.py -q` passes.
- `uv run ruff check src/mycli/infrastructure/sqlite_session_store.py src/mycli/services/diagnostics/doctor.py tests/unit/infrastructure/test_sqlite_session_store.py tests/unit/services/test_doctor_service.py` passes.
- Trellis task is archived and the slice is committed on the feature branch only.
