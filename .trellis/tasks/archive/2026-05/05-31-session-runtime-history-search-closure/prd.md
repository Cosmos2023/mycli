# Session Runtime History Search Closure

## Problem

`mycli` can persist runtime-first sessions in `history_items`, but `/search`
currently searches only legacy `conversation_messages`. That means durable,
recoverable runtime history can be invisible to search.

## Scope

Implement a complete Session/State search closure for runtime history.

Included:

- Add an FTS index for `history_items`.
- Backfill existing history rows into the index.
- Keep insert/delete/update behavior in sync through triggers.
- Search both `conversation_messages` and `history_items`.
- Preserve bounded, human-readable `/search` output.
- Extend doctor session DB schema checks so missing runtime history search
  objects are reported.
- Add unit tests for store, service, and doctor.

Excluded:

- No UI redesign.
- No external search engine.
- No MCP/skills/subagent/ACP productization.
- No migration framework rewrite.

## Requirements

### A. SQLite Search Index

- Create `history_items_fts` with `session_id`, `item_id`, `sequence_no`, and
  searchable `content`.
- Add triggers for insert/delete/update on `history_items`.
- Backfill existing history rows on store initialization.

### B. Search Semantics

- `SQLiteSessionStore.search_messages()` must search both legacy conversation
  messages and runtime history items.
- Results must respect `workspace_root` filtering.
- Results must remain bounded by `limit`.
- Output should distinguish history rows from legacy conversation messages
  without exposing raw JSON payloads.

### C. Service Output

- `SessionService.search_sessions()` should render history matches in a stable
  bounded form.
- Empty query and no-match behavior remains unchanged.

### D. Doctor

- Doctor must fail `sessions_db` when runtime history search FTS objects are
  missing, with bounded object names.
- Doctor must not repair or create missing objects.

## Acceptance Criteria

- Store tests prove history-only sessions are searchable.
- Store tests prove legacy DB history rows are backfilled.
- Service tests prove `/search` renders history matches.
- Doctor tests prove missing `history_items_fts` objects fail session DB check.
- Relevant ruff, mypy, Python tests, and Node tests pass.
- Task is archived and committed on the feature branch.
