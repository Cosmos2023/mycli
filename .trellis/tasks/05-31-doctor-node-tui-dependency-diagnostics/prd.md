# Doctor Node TUI Dependency Diagnostics

## Goal

Improve `mycli doctor` so it catches the Node TUI dependency state that caused
recent runtime/TUI smoke worktrees to fail: Node and npm can be installed while
`tui/node/node_modules/.bin/tsx` is missing.

## Context

- `build_node_command(...)` requires `tui/node/node_modules/.bin/tsx` for the
  normal Node TUI entrypoint.
- `mycli doctor` currently checks Python TUI importability, Node TUI source
  presence, and whether `node` / `npm` are on PATH.
- That leaves a gap: doctor can report Node/npm OK even though launching the
  Node TUI would fail with “dependencies are not installed”.
- Doctor must remain read-only and must not run `npm install`.

## Requirements

- Add a read-only doctor check for Node TUI runtime dependencies.
- Check should inspect the repo-local Node TUI dependency marker:
  `tui/node/node_modules/.bin/tsx`.
- If Node TUI source exists and `tsx` is present, report OK.
- If Node TUI source exists and `tsx` is missing, report WARNING with a clear
  remediation command: `npm --prefix tui/node install`.
- If Node TUI source is missing, keep the existing source warning and avoid a
  misleading dependency failure.
- Do not create files or directories.
- Do not run `npm install`, `npm ci`, or any external dependency install.
- Preserve existing warning-only behavior for Node/npm/TUI availability.

## Non-Goals

- Do not start the Node TUI.
- Do not validate every npm package in `node_modules`.
- Do not change `build_node_command(...)`.
- Do not merge into `main`.

## Acceptance Criteria

- Unit test proves doctor reports OK when `tsx` exists.
- Unit test proves doctor reports WARNING when Node source exists but `tsx` is
  missing.
- Unit test proves doctor remains read-only and does not create
  `node_modules`.
- Existing doctor tests continue to pass.
- Python lint/type-check/focused tests pass.
- Work is committed and archived on `feature/mycli-doctor-node-tui-deps` only.
