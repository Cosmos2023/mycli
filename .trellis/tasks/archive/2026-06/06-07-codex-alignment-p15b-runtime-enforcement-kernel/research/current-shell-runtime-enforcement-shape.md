# Current Shell Runtime Enforcement Shape

## Findings

- `BashTool.execute()` resolves `cwd` with `resolve_workspace_path()` and rejects non-directory or out-of-workspace cwd values.
- `execute_bash()` calls `subprocess.run(..., shell=True, cwd=effective_cwd, executable=os.environ.get("SHELL", "/bin/bash"))` and currently inherits the full parent environment.
- Bash timeout is accepted from arguments with default `120`, but there is no runtime policy max cap separate from the tool argument.
- Bash output is truncated by constants in `src/mycli/tools/bash.py`: `OUTPUT_CHAR_LIMIT`, `OUTPUT_HEAD_CHARS`, and `OUTPUT_TAIL_CHARS`.
- P14 `RuntimePolicyGate` decides allow/deny/needs_approval before execution and emits bounded runtime policy trace rows.
- `ToolExecutionService` traces `tool_execution` after execution and stores the full raw payload locally in turn item metadata, while trace payloads are already bounded by helper methods.
- P15a added model-visible `RuntimeEnvironmentContract`, but shell execution does not yet consume a typed enforcement option set derived from the same policy.

## Design Direction

- Add a small typed shell enforcement options object in the runtime policy domain.
- Derive it from `ExecutionPolicy` / `SandboxProfile` with conservative defaults: workspace cwd, restricted shell, sanitized env, bounded timeout, and current Bash output limits.
- Pass enforcement options to Bash execution through tool arguments metadata or a runtime-only injected argument key that provider schemas do not advertise.
- Keep raw command and raw env values out of trace/doctor/dry-run summaries. Tool local raw payload may keep existing command behavior for local transcript compatibility, but diagnostics should use bounded enforcement metadata.
- Keep the change shell-lane only for P15b.
