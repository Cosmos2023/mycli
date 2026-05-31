# Session Maintenance Apply Vacuum

## Problem

`mycli` can report SQLite freelist pages and explicitly delete empty sessions or
orphan child rows, but it still lacks a safe explicit command to reclaim free
pages. A mature local agent foundation should provide a bounded maintenance
operation instead of requiring users to run manual SQLite commands.

Hermes-agent is the maturity reference only. Do not copy Hermes code.

## Scope

Baseline branch: `feature/mycli-foundation-hardening-audit`

Default integration policy: do not merge to `main`.

This slice covers Session / State parity by adding explicit SQLite vacuum
maintenance for the session DB.

## Requirements

- Add a store-level vacuum operation that:
  - runs only when explicitly called;
  - executes SQLite `VACUUM`;
  - returns before/after `db_size_bytes`, `page_count`, `freelist_count`, and
    `page_size`;
  - does not delete sessions or child rows;
  - does not repair lineage or orphan rows;
  - does not run from doctor, dry-run report, empty cleanup, or orphan cleanup.
- Add service formatting as bounded `key=value` output.
- Add CLI slash command `/session-maintenance --apply-vacuum`.
- Include the command in help, completion, and Node TUI slash discovery.
- Keep default `/session-maintenance` read-only.
- Keep `/session-maintenance --apply-empty` and
  `/session-maintenance --apply-orphans` behavior unchanged.

## Acceptance Criteria

- Store unit tests prove:
  - vacuum returns before/after page and file-size metrics;
  - existing sessions and messages remain intact;
  - empty/orphan cleanup paths do not run vacuum.
- Service/CLI tests prove `/session-maintenance --apply-vacuum` output is
  routed and formatted.
- Completion and Node gateway command discovery include the new slash command.
- Focused checks pass:
  - `uv run pytest tests/unit/infrastructure/test_sqlite_session_store.py tests/unit/services/test_session_service.py tests/unit/cli/test_main.py tests/unit/cli/test_tui_completion.py tests/unit/cli/node_tui/test_gateway.py -q`
  - `uv run ruff check src/mycli/domain/session_store.py src/mycli/infrastructure/sqlite_session_store.py src/mycli/state/session_service.py src/mycli/application/turn_service.py src/mycli/cli/repl.py src/mycli/cli/tui/completion.py src/mycli/cli/node_tui/gateway.py tests/unit/infrastructure/test_sqlite_session_store.py tests/unit/services/test_session_service.py tests/unit/cli/test_main.py tests/unit/cli/test_tui_completion.py tests/unit/cli/node_tui/test_gateway.py`
  - `uv run mypy src/mycli/domain/session_store.py src/mycli/infrastructure/sqlite_session_store.py src/mycli/state/session_service.py src/mycli/application/turn_service.py src/mycli/cli/repl.py src/mycli/cli/tui/completion.py src/mycli/cli/node_tui/gateway.py`
- Trellis research, PRD, implementation context, check context, and check
  results are present.
- Task is archived after verification.

## Non-goals

- No automatic vacuum from doctor.
- No automatic vacuum from empty/orphan cleanup.
- No session deletion.
- No orphan or lineage repair.
- No background scheduler.
- No MCP, skills, subagent/multi-agent, or ACP productization.
- No merge to `main`.
