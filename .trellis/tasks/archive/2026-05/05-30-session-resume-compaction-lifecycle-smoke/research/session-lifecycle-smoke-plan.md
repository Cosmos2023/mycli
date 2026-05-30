# Session Lifecycle Smoke Plan

## Relevant Contracts

- `.trellis/spec/backend/database-guidelines.md`
  - `~/.mycli/sessions.db` is the canonical session store.
  - Resume/lineage must respect `conversation_trees.parent_id` and
    `fork_point`; do not naively concatenate transcripts.
- `.trellis/spec/backend/logging-guidelines.md`
  - Runtime logs live under `~/.mycli/logs`.
  - Raw model payloads live under `~/.mycli/logs/model-raw/<safe-session-id>/`.
  - `WorkspaceLogService.set_session_id()` must follow active runtime session
    changes after `/resume` and `/fork`.
- `.trellis/spec/backend/quality-guidelines.md`
  - Trace files live under `~/.mycli/traces/`.
  - Runtime diagnostics are local-only and must not change provider request
    shape unless the user-visible contract changes.

## Local Code Paths

- CLI command routing: `src/mycli/cli/repl.py`
- Service session mutation: `src/mycli/application/turn_service.py`
- Runtime rebinding: `src/mycli/application/runtime/agent_runtime.py`
- Canonical SQLite store: `src/mycli/infrastructure/sqlite_session_store.py`
- Conversation tree service: `src/mycli/services/session_service.py`
- Storage layout: `src/mycli/services/storage_layout.py`

## Existing Targeted Tests

- `tests/unit/infrastructure/test_sqlite_session_store.py`
- `tests/unit/application/test_agent_runtime.py`
  - resume-to-tip behavior
  - fork switches active session
  - runtime `rebind_session()` updates log context
  - compaction metrics reset/rebind behavior
- `tests/integration/test_turn_service.py`
  - compaction threshold behavior
- `tests/unit/test_l4_rehydration.py`
- `tests/unit/test_compaction_transcript_validity.py`

## Verification Strategy

1. Run doctor and targeted tests to confirm baseline behavior.
2. Run a real CLI session with unique root and branch ids.
3. Inspect SQLite using read-only queries.
4. Inspect user-level logs, raw payload buckets, and traces.
5. Scan inspected raw payload/log snippets for obvious secret leakage patterns.
6. Write a report with facts and residual risks.

## Compaction Note

A forced real long-context provider smoke is intentionally not the default for
this task because it is costly and provider-sensitive. The acceptance target is
to verify compaction with focused automated tests plus trace/rollout evidence.
Escalate to a real forced-threshold provider smoke only if targeted tests fail
to exercise the lifecycle boundary.
