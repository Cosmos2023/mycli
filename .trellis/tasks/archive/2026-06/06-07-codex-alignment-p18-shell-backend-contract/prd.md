# P18 PRD: Shell Backend Contract

## Goal

Extract a provider-neutral shell backend contract while keeping local subprocess as the only default implementation.

## Scope

- Define `ShellBackendProfile` / backend capability metadata in domain runtime.
- Extend `ShellExecutionOptions` and `RuntimeEnvironmentContract` with bounded backend metadata.
- Add `ShellBackend` protocol and `LocalShellBackend` implementation.
- Make `BashTool` execute through a backend instance, defaulting to local.
- Add doctor shell backend diagnostics for local backend availability/capability.
- Preserve P17 process lifecycle metadata.

## Non-goals

- No Docker, SSH, Modal, Daytona, Singularity, seatbelt, seccomp, cloud sandbox, or remote backend implementation.
- No provider API calls.
- No provider request shape changes.
- No compact/rehydration changes.

## Acceptance

- Unit tests cover shell backend profile metadata and runtime environment contract.
- Unit tests prove `BashTool` uses the backend contract and local backend preserves foreground/background behavior.
- Doctor backend diagnostics report local backend bounded status and no raw command/env/output.
- P17 shell lifecycle tests remain green.
- `uv run ruff check src tests evaluation`, `uv run mypy src/mycli`, and `uv run pytest -q` pass before archive.
- Compact/rehydration diff audit remains empty.
