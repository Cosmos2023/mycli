# Session Maintenance Dry Run Report Research

## Current State

- `SQLiteSessionStore` is the canonical local session store at `~/.mycli/sessions.db`.
- The store already exposes read-only listing and search APIs, but it has no maintenance or cleanup-report API.
- Doctor already checks corruption-like state for schema/search objects/orphaned critical state, but those checks are health gates, not a user-facing session maintenance summary.
- CLI exposes `/session`, `/sessions`, `/search <query>`, and resume/fork commands. There is no read-only command for cleanup/vacuum/prune signals.

## Gap

Hermes-like long-running local agents need a safe pre-cleanup diagnostic surface before destructive maintenance. mycli currently cannot answer basic maintenance questions such as:

- How many sessions exist for this workspace?
- How many sessions are empty and likely cleanup candidates?
- How much SQLite file/free-page footprint exists?
- Is the report a dry-run rather than a mutating cleanup?

## Design Direction

Add a read-only `SessionMaintenanceReport` domain payload and expose it through store -> session service -> turn service -> slash command. Keep the first slice deliberately non-destructive:

- no deletion
- no `VACUUM`
- no repair
- no schema migration beyond normal store initialization

The output should be deterministic and machine-scannable enough for logs/smoke while still readable in CLI/TUI.

## Relevant Specs

- `.trellis/spec/backend/database-guidelines.md`
- `.trellis/spec/backend/quality-guidelines.md`
- `.trellis/spec/guides/index.md`
