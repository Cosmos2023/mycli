# Doctor Storage Layout Diagnostics

## Problem

`mycli doctor` already checks config, sessions DB, logs, FileHistory, TUI, and
MCP configuration. The storage layout now also reserves user-home paths for
`traces/` and `artifacts/`, but doctor does not report whether those paths are
usable or accidentally occupied by files. That leaves a diagnostics gap for
runtime trace and artifact failures.

## Goal

Add a read-only doctor check for reserved storage layout directories:

- `~/.mycli/traces`
- `~/.mycli/artifacts`

The check should help users understand whether local diagnostics storage can be
used without mutating state.

## Non-Goals

- Do not create missing directories.
- Do not write trace or artifact files.
- Do not inspect trace contents or artifact contents.
- Do not change session DB schema, log layout, or runtime write behavior.

## Acceptance Criteria

- `DoctorService.run()` includes a storage-layout check.
- Missing `traces/` and `artifacts/` directories are OK because doctor is
  read-only and runtime code may create directories lazily.
- Existing directories are OK when they are directories and writable.
- A reserved path that exists as a regular file is `FAILED`.
- An existing reserved directory without write bits is `FAILED`.
- The rendered report includes the check name and a bounded detail path.
- Unit tests cover healthy layout, missing layout, file conflict, and
  non-writable directory cases.
- Targeted ruff, mypy, and pytest checks pass.

## Risks

- Filesystem writability checks based on mode bits are conservative and avoid
  creating probe files. This matches doctor read-only semantics, but cannot
  prove all ACL/network filesystem behavior.
- Missing directories should not be warnings, otherwise fresh installs become
  noisier without a real action item.
