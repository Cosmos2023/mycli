# Session State Recovery Gap

Date: 2026-05-31

Baseline: `feature/mycli-foundation-hardening-audit`

Hermes reference: semantic maturity only. Do not copy Hermes code.

## Current Capabilities

- `SQLiteSessionStore` owns local session persistence under `~/.mycli/sessions.db`.
- The schema includes:
  - `sessions`
  - `conversation_messages`
  - `conversation_messages_fts`
  - `conversation_trees`
  - `history_items`
  - `turn_rollouts`
  - `session_state`
  - `session_summaries`
- Store initialization enables foreign keys, WAL with fallback, write retries,
  FTS backfill, and schema version recording.
- Root-to-tip resume exists through `resolve_resume_session_id()`.
- Fork lineage replay uses `conversation_trees.parent_id` and `fork_point`.
- Pending approval, suspended turns, pending clarification, plan state, turn
  records, history items, rollouts, and summaries round-trip through
  `SessionService`.

## Existing Test Coverage

- `tests/unit/infrastructure/test_sqlite_session_store.py`
  - root-to-tip resume chooses latest descendant
  - fork lineage avoids duplicated parent prefix
  - repeated boundary user message deduplication
  - lineage cycle detection during lineage load
  - FTS search/backfill
- `tests/unit/services/test_session_service.py`
  - ancestor resume loads current tip lineage
  - fork and rewind metadata persistence
  - pending approval persistence
  - suspended turn persistence
  - pending clarification persistence
  - runtime snapshot reconstruction for waiting approval
- `tests/integration/test_turn_service.py`
  - waiting states and runtime turn handling coverage exists but does not
    currently validate corrupt session DB diagnostics.

## Gap

`mycli doctor` currently checks only that the DB opens and that three tables
exist: `sessions`, `conversation_messages`, and `turn_rollouts`.

That is too weak for a long-lived local agent foundation because resume/fork and
waiting-state recovery depend on the rest of the storage graph:

- `conversation_trees` is required for root-to-tip resume and fork replay.
- `history_items`, `session_state`, and `session_summaries` are required for
  recoverable waiting turns and durable session metadata.
- Foreign-key violations and orphan rows can make session state appear present
  while runtime recovery later fails or silently drops state.
- Parent lineage cycles can make resume/lineage traversal fail.
- Invalid fork points can corrupt replay semantics even when all rows exist.

## This Slice

Make session DB doctor diagnostics catch recovery-breaking state without
mutating the database:

- Require the full session storage table set.
- Run `PRAGMA foreign_key_check`.
- Detect orphan rows in key child tables when legacy/corrupt DBs lack enforced
  foreign keys.
- Detect conversation lineage cycles.
- Detect negative fork points.
- Detect fork points beyond the current session's stored message count.
- Keep output actionable and bounded.

## Non-goals

- No automatic repair, prune, vacuum, or migration command in this slice.
- No MCP, skills, subagent/multi-agent, or ACP productization.
- No main merge.
- No Hermes code copy.

## Verification

- `uv run pytest tests/unit/services/test_doctor_service.py tests/unit/services/test_session_service.py tests/unit/infrastructure/test_sqlite_session_store.py -q`
- `uv run ruff check src/mycli/services/diagnostics/doctor.py tests/unit/services/test_doctor_service.py`
