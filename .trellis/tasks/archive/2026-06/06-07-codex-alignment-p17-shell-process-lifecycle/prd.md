# P17 PRD: Shell Process Lifecycle Hardening

## Goal

Make shell execution governable after execution starts by standardizing bounded shell process lifecycle metadata for foreground timeout, background registry, BashOutput, KillShell, ToolExecutionService trace, and doctor diagnostics.

## Scope

- Strengthen `ShellProcessRegistry` lifecycle state and bounded diagnostics.
- Remove raw command exposure from `SHELL_REGISTRY.list()` / `read()` / `kill()` diagnostics and `TurnService.inspect_bashes()`.
- Add bounded shell process metadata to foreground timeout, background start, output read, and kill results.
- Extend shell lifecycle trace with bounded process fields when shell tool results provide them.
- Add doctor shell process diagnostics for running/stale/exited/killed/orphan-like registry states.
- Keep legacy compatibility for `shell_id` / `bash_id` and existing basic tests.

## Non-goals

- No Docker, SSH, cloud sandbox, seatbelt, seccomp, or OS sandbox implementation.
- No command rewriting.
- No approval semantics change.
- No provider request shape change.
- No compact/rehydration implementation change.

## Requirements

1. Background shell start returns bounded lifecycle/process metadata:
   - `shell_id`, `status`, `process_state`, `started_at`, `last_observed_at`, `cwd`, `timeout`, command hash/pattern metadata, output counters.
2. `BashOutput` returns bounded status and output body for model consumption, but diagnostics metadata must include output counters/truncation and not raw command.
3. `KillShell` returns bounded kill/cleanup metadata and terminal process state.
4. Foreground timeout returns explicit cleanup metadata and `process_state=timed_out`.
5. Tool runtime lifecycle trace for shell tools may include bounded process metadata only: shell id, process state, elapsed/duration, output char counts, truncation flags, cleanup result, command hash/length/pattern class if present.
6. Doctor reports shell process diagnostics from registry without printing raw command or output.
7. Existing runtime policy, sandbox, approval resume, context, subagent, MCP, plugin, hook behavior must not regress.

## Acceptance

- Unit tests cover background registry lifecycle, raw command redaction, kill lifecycle, foreground timeout cleanup metadata, and doctor shell process diagnostics.
- Unit tests cover shell lifecycle trace bounded process metadata.
- `uv run ruff check src tests evaluation` passes.
- `uv run mypy src/mycli` passes.
- Targeted tests for shell/tool/doctor pass; full pytest should pass before final P17 archive.
- Compact/rehydration diff audit remains empty for protected modules.
