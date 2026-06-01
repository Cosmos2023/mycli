# Shell Terminal Notes

## Current state

- `BashTool` executes local subprocesses with a timeout and background option.
- `SafetyPolicy` handles high-risk shell approval before execution.
- `shell_safety.py` already detects destructive commands, curl-to-shell,
  redirection, sudo, and dedicated-tool reroutes.
- `BashOutput` reads incremental output from `ShellProcessRegistry`.
- `KillShell` terminates background processes.

## Target

Keep the backend local-only for this slice. Improve the result contract so
runtime/TUI/doctor/model can diagnose shell work without parsing raw output:

- cwd-aware execution
- separate stdout/stderr
- bounded output with truncation counters
- stable timeout/nonzero/error kinds
- command pattern surfaced for diagnostics
