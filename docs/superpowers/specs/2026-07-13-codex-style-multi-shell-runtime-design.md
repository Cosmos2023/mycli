# Codex-Style Multi-Shell Runtime Design

## Status

Approved for implementation planning on 2026-07-13.

## Goal

Evolve mycli from a Bash-only execution contract into a shell-aware runtime that behaves consistently across Linux, macOS, and native Windows. The active shell type must be understood by model prompting, tool execution, safety analysis, approval rules, hooks, diagnostics, persistence, and the TUI.

The user-facing model tool remains stable across platforms:

- `Shell`
- `ShellOutput`
- `KillShell`

Legacy `Bash` and `BashOutput` names remain accepted as compatibility aliases but are not exposed in new model tool lists.

## Non-Goals

- Do not expose separate Bash, PowerShell, and CMD tools to the model.
- Do not execute Bash syntax through PowerShell or CMD.
- Do not preserve the current requirement that native Windows install Git Bash.
- Do not add a required `shell_kind` configuration setting.
- Do not implement Fish, NuShell, or arbitrary unknown shell syntax in this phase.
- Do not replace the existing foreground/background shell lifecycle or public shell IDs.

## Design Principles

1. Shell type is runtime state, not an incidental executable path.
2. The model sees one stable Shell tool contract on every platform.
3. Execution arguments and generated command syntax must agree.
4. Safety analysis fails conservatively: an unrecognized construct requires confirmation and is never silently allowed.
5. Explicit but unusable shell paths follow Codex compatibility behavior: ignore them and continue platform detection.
6. Lifecycle state, shell IDs, output bounding, interruption, timeout, and termination remain shell-independent.
7. Platform-specific prompt content stays short and close to the Shell tool definition to preserve prompt-cache stability.

## Domain Model

Introduce a typed shell profile:

```python
class ShellKind(StrEnum):
    ZSH = "zsh"
    BASH = "bash"
    SH = "sh"
    POWERSHELL = "powershell"
    CMD = "cmd"


class PowerShellEdition(StrEnum):
    CORE = "core"
    DESKTOP = "desktop"


@dataclass(frozen=True, slots=True)
class ShellProfile:
    kind: ShellKind
    executable: Path
    powershell_edition: PowerShellEdition | None = None
```

Invariants:

- `powershell_edition` is set only for `ShellKind.POWERSHELL`.
- `pwsh` and `pwsh.exe` map to `CORE`.
- `powershell` and `powershell.exe` map to `DESKTOP`.
- The profile is resolved once per runtime configuration and threaded through all shell consumers.
- Model-visible and persisted diagnostics may contain `kind` and edition but must not expose a private absolute executable path unless the user explicitly requests diagnostics.

## Shell Detection

### Recognized Executable Names

Executable names are matched case-insensitively after removing `.exe`:

| Name | Shell kind |
| --- | --- |
| `zsh` | `zsh` |
| `bash` | `bash` |
| `sh` | `sh` |
| `pwsh` | `powershell/core` |
| `powershell` | `powershell/desktop` |
| `cmd` | `cmd` |

### Explicit `shell_path`

The existing `shell_path` and `MYCLI_SHELL_PATH` inputs remain supported.

- If the path exists and its executable name is recognized, use it.
- If the path is missing, not a file, unknown, or cannot be used as the detected type, ignore it and continue normal platform detection.
- Do not add `shell_kind` configuration.
- Doctor reports that an explicit override was ignored, but normal startup is not blocked.

This deliberately matches Codex's forgiving fallback behavior rather than the current strict configuration error.

### Windows

Detection order:

1. Recognized, usable explicit `shell_path`.
2. `pwsh` on `PATH`.
3. `C:\Program Files\PowerShell\7\pwsh.exe`.
4. `powershell`/`powershell.exe` on `PATH`.
5. `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`.
6. `cmd`/`cmd.exe` on `PATH`.
7. Ultimate fallback: `cmd.exe`.

Git Bash remains usable only when explicitly selected through a recognized `shell_path`, or when the host environment reports Bash as the user shell. It is no longer required for native Windows startup.

### macOS

Detection order:

1. Recognized, usable explicit `shell_path`.
2. Recognized user login shell.
3. `zsh`.
4. `bash`.
5. `sh`.
6. Ultimate fallback: `/bin/sh`.

### Linux

Detection order:

1. Recognized, usable explicit `shell_path`.
2. Recognized user login shell.
3. `bash`.
4. `zsh`.
5. `sh`.
6. Ultimate fallback: `/bin/sh`.

User login shell discovery should use the operating-system account database where practical, not only the mutable `SHELL` environment variable. Tests use injected discovery functions.

## Command Derivation

`ShellProfile` owns command argument derivation:

```text
zsh/bash/sh:
  <executable> -c <command>

PowerShell Core/Desktop:
  <executable> -NoLogo -NoProfile -NonInteractive -Command <command>

CMD:
  <executable> /d /s /c <command>
```

The process is still spawned with an explicit argv list and never with Python `shell=True`.

The existing process controller remains responsible for process groups, Windows process groups, interrupt escalation, timeout cleanup, taskkill fallback, and terminal-state truthfulness.

## Tool Contract

### Model-Visible Tools

Expose only:

- `Shell`
- `ShellOutput`
- `KillShell`

`Shell` keeps the current command, timeout, cwd, and background parameters. The model does not choose `shell_kind`; it generates commands for the profile declared in the tool prompt.

### Compatibility Aliases

The runtime registry accepts:

- `Bash` as an alias for `Shell`.
- `BashOutput` as an alias for `ShellOutput`.

Aliases are used for old sessions, provider replay, plugins, hooks, and approval migration. They are omitted from new model tool schemas to avoid duplicate tool selection.

Public shell IDs and payload keys remain compatible. New payload metadata may add:

```json
{
  "shell_kind": "powershell",
  "shell_edition": "core"
}
```

## Model Prompting

The stable base prompt refers to `Shell`, not `Bash`.

A compact runtime fragment is generated from `ShellProfile` and placed adjacent to the Shell tool instructions.

Examples:

```text
Current shell: PowerShell 7.
Generate PowerShell commands. Use $env:NAME for environment variables.
PowerShell pipelines pass objects, not Bash text streams.
Do not use Bash-only syntax.
```

```text
Current shell: Windows Command Prompt.
Generate cmd.exe syntax. Use %NAME% for environment variables.
PowerShell and POSIX shell syntax are unavailable.
```

```text
Current shell: zsh.
Generate POSIX-compatible zsh commands unless zsh-specific syntax is required.
```

PowerShell edition guidance must distinguish Core 7+ from Desktop 5.1. In particular, Desktop guidance must not suggest `&&`, `||`, `?:`, or other unsupported syntax.

Only this small fragment varies by platform. General tool-use policy remains stable for cache reuse.

## Shell-Aware Safety

Replace the single Bash-oriented parser boundary with a dispatcher:

```python
class ShellSafetyAdapter(Protocol):
    def analyze(self, command: str) -> ShellSafetyAnalysis: ...
    def derive_command_pattern(self, command: str) -> str: ...
    def dedicated_tool_for_command(self, command: str) -> str | None: ...
```

Adapters:

- `PosixShellSafetyAdapter` for zsh, bash, and sh.
- `PowerShellSafetyAdapter` for PowerShell Core and Desktop.
- `CmdSafetyAdapter` for CMD.

### POSIX

Retain current mature behavior, with existing Bash-oriented functions moved behind the adapter without behavior changes.

### PowerShell

The first implementation must identify at least:

- statement boundaries and pipeline boundaries;
- cmdlet and native executable command heads;
- `Remove-Item`, `Clear-Content`, `Stop-Process`, destructive git commands, and analogous high-risk operations;
- output redirection and filesystem mutation;
- script blocks, invocation operator `&`, environment variables, and nested expressions as constructs requiring conservative handling;
- dedicated Read, Write, Edit, and search tool rerouting where reliable.

### CMD

The first implementation must identify at least:

- `&`, `&&`, `||`, and `|` command boundaries;
- redirection operators;
- `%VAR%` expansion;
- destructive filesystem and process commands;
- destructive git commands;
- dedicated tool rerouting where reliable.

### Conservative Rule

- Reliably safe command: `ALLOW`.
- Known risky command or mutation: `CONFIRM` or existing `DENY` policy.
- Parse failure, ambiguous expansion, or unsupported construct: `CONFIRM`.
- No adapter may convert a parse failure into `ALLOW`.

## Approval Rules

Approval identity includes shell kind because identical text can have different meanings:

```text
shell:bash:git status
shell:powershell:Get-ChildItem
shell:cmd:dir
```

Legacy `Bash:<pattern>` rules migrate only to POSIX shell kinds. They must not authorize PowerShell or CMD commands.

Approval UI continues to display the human-readable command and adds the active shell label when it is not obvious.

## Hooks

Hook command forms remain distinct:

- argv-list hooks execute directly and do not use a shell profile;
- string hooks execute through the active `ShellProfile`;
- future hook configuration may explicitly choose a supported shell kind, but that is outside this phase.

Hook command hashing and approval identity include the active shell kind. A hook loaded under Bash must not share approval with the same string under PowerShell.

## Lint And Diagnostics

Built-in lint commands should use argv execution whenever possible. Shell execution is reserved for configured compound commands that require pipelines, redirection, or chaining.

Doctor reports:

- active shell kind and PowerShell edition;
- whether an explicit `shell_path` was accepted or ignored;
- resolved executable only in user-facing diagnostics, never model-visible traces;
- fallback chain and actionable installation guidance.

Windows is healthy with `pwsh`, Windows PowerShell, or CMD. Git Bash is optional.

## Persistence And Sessions

Session and event payloads record stable shell metadata, not the absolute executable path:

```json
{
  "shell_kind": "powershell",
  "shell_edition": "desktop"
}
```

Old shell records without metadata render as `bash` only when the originating tool name was `Bash`; otherwise they use an `unknown` display label without changing execution behavior.

Restoring an old running shell continues to use persisted process/session state. A newly detected profile does not rewrite the shell kind of historical terminal entries.

## TUI

The command cell remains the existing Codex-style lifecycle surface:

- `Running`
- `Ran`
- `Failed`
- `Interrupted`
- `Timed out`
- `Killed`

Collapsed cells stay compact. Expanded details add:

```text
Shell: PowerShell 7
Process: 18420
Elapsed: 3s
```

The TUI uses `Shell` and `ShellOutput` labels for new activity while continuing to render legacy Bash records correctly.

## Rollout

### Phase 1: Domain And Execution

- Add `ShellKind`, `PowerShellEdition`, and `ShellProfile`.
- Implement Codex-style detection and fallback.
- Derive shell-specific argv.
- Thread profiles through backend/session requests.
- Preserve lifecycle behavior on all shell kinds.

### Phase 2: Unified Tool And Prompt Contract

- Introduce `Shell` and `ShellOutput`.
- Add non-exposed legacy aliases.
- Replace Bash-only base prompt wording.
- Add compact profile-specific guidance.
- Add shell metadata to payloads and TUI details.

### Phase 3: Safety And Approvals

- Introduce safety adapter dispatch.
- Preserve POSIX behavior.
- Add conservative PowerShell and CMD analyzers.
- Scope approval identity by shell kind.
- Migrate legacy Bash approval rules only to POSIX kinds.

### Phase 4: Consumers And Verification

- Make hooks, lint, doctor, and configured commands profile-aware.
- Add Windows PowerShell Core, Desktop, and CMD fallback tests.
- Add Linux Bash and macOS zsh integration coverage.
- Update documentation and CI.

Each phase must leave the repository testable and must not weaken safety while waiting for later phases. If PowerShell/CMD safety adapters are not ready when those shells are detectable, non-trivial commands on those profiles default to confirmation.

## Testing Strategy

### Unit Tests

- injected platform, PATH, account-shell, and filesystem detection;
- explicit valid, missing, and unknown paths;
- PowerShell Core/Desktop distinction;
- command argv derivation for all shell kinds;
- safety dispatch and conservative parse failure;
- approval key shell scoping;
- legacy tool and approval compatibility.

### Integration Tests

- foreground output and non-zero exits for each available shell kind;
- background output polling;
- timeout, interruption, and KillShell;
- hooks under active profile;
- prompt fragment and exposed tool schema;
- session restore and TUI projection of shell metadata.

### CI

- Ubuntu: Bash profile.
- macOS: zsh profile.
- Windows: PowerShell Core when available.
- Windows: Windows PowerShell Desktop.
- Windows: forced CMD fallback.

Tests that require a specific shell use explicit injected or discovered profiles and skip only when the host executable genuinely cannot be installed or provided by the runner.

## Success Criteria

1. Native Windows starts and executes agent commands without Git Bash.
2. The model sees one `Shell` tool on every platform.
3. Commands use syntax matching the detected shell.
4. PowerShell Core, PowerShell Desktop, and CMD use correct invocation arguments.
5. Unsupported or ambiguous PowerShell/CMD syntax never receives automatic approval.
6. Existing Bash sessions, calls, approvals, and lifecycle payloads remain readable.
7. Background polling, interruption, timeout, and KillShell retain their current behavior.
8. Hooks, lint, doctor, persistence, and TUI agree on the active shell kind.
9. Linux, macOS, and Windows CI pass with shell-specific integration coverage.
