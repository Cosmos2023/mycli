# P17 Research: Shell Process Lifecycle

## Current implementation facts

- `src/mycli/tools/bash.py` runs foreground shell commands with `subprocess.run(...)` and returns timeout metadata, output char counts, truncation flags, cwd, and error_kind.
- Background shell starts through `SHELL_REGISTRY.start(...)` and returns `bash_id` / `shell_id` / `status=running` / timeout. The module-level `_background_processes` mirrors registry `Popen` objects for legacy tests.
- `src/mycli/tools/shell_registry.py` stores `ShellProcess(command=raw command, process, started_at, output, read_offset)` and `list()` / `read()` currently return the raw command.
- `src/mycli/tools/kill_shell.py` delegates to `SHELL_REGISTRY.kill(...)` and returns `status=killed` or `shell_not_found`.
- `ToolExecutionService` already emits `tool_runtime_lifecycle` trace rows with `planned`, `policy_checked`, `started`, `progress`, and terminal phases. Shell trace redaction already suppresses stdout/stderr previews and excludes raw shell args from `tool_execution` trace.
- `TurnService.inspect_bashes()` currently prints shell id, status, exit code, and raw command. This violates the P17 bounded diagnostics goal.
- Doctor currently summarizes tool lifecycle from trace files, but has no direct shell registry health check.

## Gaps

1. Background shell registry keeps and reports raw command.
2. Background shell state is only `running` / `exited`; it lacks P17 lifecycle fields like `running_background`, `killed`, `last_observed_at`, `terminal_state`, output counters, cleanup result.
3. Foreground timeout result has timeout metadata but no explicit cleanup result / shell process state metadata.
4. KeyboardInterrupt handling in `ToolExecutionService` records `tool_interrupted`, but no shell cleanup metadata is available.
5. `KillShell` result is not rich enough to explain lifecycle state transitions.
6. Doctor cannot report stale/orphan/running background shells directly from the registry.

## Implementation direction

- Keep local subprocess behavior, no Docker/SSH/cloud backend.
- Make `ShellProcessRegistry` the bounded source for background shell process state.
- Store a `command_pattern` / hash / command length instead of exposing raw command through list/read/kill diagnostics.
- Keep raw command only in the runtime process object as needed to start the process; do not return it through diagnostics.
- Add bounded `process` / `shell_process` metadata into Bash/BashOutput/KillShell raw payloads.
- Extend `ToolExecutionService` shell lifecycle trace to include bounded shell process metadata when available.
- Add Doctor shell process diagnostics that summarize registry states without raw command/output.

## Protected boundaries

- Do not touch compact/rehydration modules.
- Do not change provider request shape.
- Do not add dependencies.
- Do not output raw command, raw env, stdout/stderr body, secrets, provider payload body in trace/doctor/dry-run.
