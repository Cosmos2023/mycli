# Shell Terminal Diagnostics Hardening

## Problem

`Bash` can execute commands and already has a safety-policy foundation, but the
tool result shape is still thin for real local tasks:

- `cwd` is not a first-class argument.
- stdout/stderr are merged too early.
- timeout and non-zero exits lack stable error kinds.
- long-output truncation has little machine-readable metadata.
- background shell output/kill failures are not consistently shaped.

## Scope

This slice covers built-in terminal tools:

- `Bash`
- `BashOutput`
- `KillShell`
- formatter output for Bash results
- unit tests for shell diagnostics

## Non-goals

- No Docker/SSH/cloud sandbox backend.
- No MCP, ACP, skills, subagents, browser, or computer-use productization.
- No destructive git automation.

## Requirements

1. `Bash` supports `cwd` within the workspace.
2. `Bash` returns `exit_code`, `stdout`, `stderr`, `output`, `timed_out`,
   `truncated`, `duration_ms`, `cwd`, and `command_pattern` where applicable.
3. Timeout returns stable `error_kind=timeout`.
4. Non-zero exit returns stable `error_kind=nonzero_exit`.
5. Long output includes machine-readable truncation metadata.
6. Dedicated-tool reroute keeps suggested arguments.
7. `BashOutput` and `KillShell` missing-id/not-found failures include stable
   `error_kind`.
8. Formatter renders exit code, cwd, error kind, truncation, and output tail
   without flooding model context.

## Acceptance

- Unit tests cover successful command, cwd, non-zero exit, timeout, truncation,
  reroute, BashOutput missing id, and KillShell missing/not-found.
- Existing shell safety tests still pass.
- Full Python unit/integration tests run before commit.
