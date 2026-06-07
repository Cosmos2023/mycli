# P18 Research: Shell Backend Contract

## Current state

- `BashTool` directly calls module-level `execute_bash(...)` in `src/mycli/tools/bash.py`.
- `execute_bash(...)` directly uses `subprocess.run(...)` for foreground execution and `SHELL_REGISTRY.start(...)` for background execution.
- Runtime policy can produce `ShellExecutionOptions`, but options do not include backend identity/capability.
- Runtime environment contract exposes filesystem/network/shell/approval/execpolicy, but not shell backend capability.
- Doctor has shell process diagnostics from P17, but no backend availability/capability check.

## Gap

P17 makes the local process lifecycle diagnosable, but shell execution is still hardwired to local subprocess. P18 should introduce a small backend contract so local subprocess is one implementation and future Docker/seatbelt/remote backends can be added later without rewriting BashTool or runtime policy.

## Direction

- Add bounded shell backend metadata to domain runtime contracts: backend id, mode, availability, isolation summary.
- Add a `ShellBackend` protocol and `LocalShellBackend` implementation in tools layer.
- Keep default backend as local subprocess.
- Make `BashTool` depend on a backend with `LocalShellBackend` default.
- Doctor reports local backend availability and configured/default backend without spawning provider calls or external backends.
- Do not implement Docker, SSH, cloud sandbox, network firewall, or OS sandbox.

## Redaction

Backend diagnostics may report backend id, type, availability, supported capabilities, and disabled/unsupported states. They must not report raw commands, raw env values, stdout/stderr bodies, secrets, or provider payloads.
