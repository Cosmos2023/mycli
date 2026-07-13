# mycli Cross-Platform Runtime Design

## Goal

Make the repository checkout runnable on Linux, macOS, and native Windows while preserving one Bash command model across platforms. On Windows, mycli may be launched from PowerShell, CMD, Windows Terminal, or Git Bash, but agent shell commands execute through Git for Windows Bash or another explicitly configured Bash implementation.

The first release covers the complete shell lifecycle: foreground execution, background execution, incremental output polling, timeout, interruption, and explicit termination. It also makes the Node TUI and repository development workflow platform-aware and adds three-platform CI.

## Scope

This design covers:

- the Python backend and local shell runtime;
- shell settings and executable discovery;
- process creation, process-tree termination, timeout, and interruption;
- filesystem permission compatibility;
- Node TUI launch, TTY behavior, key labels, and clipboard integration;
- source-checkout installation and development commands;
- Linux, macOS, and Windows GitHub Actions verification.

This design does not cover:

- PowerShell or CMD command semantics for agent tools;
- WSL host/guest path translation;
- automatic installation of Git for Windows;
- Windows ConPTY-backed interactive shell sessions;
- standalone installers or bundled Node/Python distributions;
- `uv tool install mycli` packaging of the Node TUI.

## pi-agent Reference

The checked-in `coding-agent` directory is byte-for-byte equivalent to `/Users/cosmos/Downloads/pi-main/packages/coding-agent` for the platform-sensitive implementation files and uses the same package version, `0.78.1`. It already contains pi's cross-platform behavior for shell discovery, Windows process handling, clipboard access, paths, browser launch, keybindings, and Windows documentation.

mycli cannot gain platform support by copying that directory again. The useful pi patterns must instead be applied to mycli's Python backend and its separate Node TUI:

- central shell resolution rather than ad hoc command selection;
- Git Bash as the Windows Bash implementation;
- platform-specific process-group creation and process-tree termination;
- native path handling outside command text;
- graceful platform capability degradation;
- focused Windows regression tests.

## Architectural Approach

Use a centralized platform adaptation layer rather than scattering `os.name`, `sys.platform`, and `process.platform` checks through business logic.

### Python platform runtime

Add a small typed platform runtime module that exposes:

- normalized platform family: Linux, macOS, or Windows;
- process creation options;
- process-tree termination operations;
- permission hardening as a best-effort capability;
- executable name and PATH lookup behavior.

The module contains platform mechanics only. Shell registry, lifecycle events, tool routing, and TUI gateway behavior continue to use platform-neutral interfaces.

### Shell resolver

Add a dedicated shell resolver that returns a typed configuration containing the executable path and invocation arguments.

Resolution order on Windows:

1. explicit `shell_path` configuration;
2. `%ProgramFiles%\Git\bin\bash.exe`;
3. `%ProgramFiles(x86)%\Git\bin\bash.exe`;
4. `bash.exe` found on PATH.

Resolution order on Linux and macOS:

1. explicit `shell_path` configuration;
2. `/bin/bash`;
3. `bash` found on PATH;
4. `sh` fallback.

All agent commands use `<shell> -c <command>`. Windows launch context does not change command semantics to PowerShell or CMD.

The resolver accepts injected platform, environment, filesystem probes, and executable lookup functions so every branch is testable on any CI host.

### Process controller

Extract process creation and termination behavior behind one process controller used by foreground and background shell execution.

Unix behavior:

- create a new session/process group;
- send escalating signals to the process group;
- preserve the existing SIGINT, SIGTERM, and SIGKILL lifecycle semantics.

Windows behavior:

- create a new process group without POSIX session arguments;
- hide child console windows where applicable;
- interrupt or terminate the full process tree using Windows-supported operations;
- never reference POSIX-only signals that are absent on Windows;
- report the observed terminal state rather than assuming termination succeeded.

The controller returns structured termination outcomes consumed by the existing shell lifecycle and cleanup-result fields. `ShellSessionManager`, `BashOutput`, and `KillShell` retain their current public contracts and shell IDs.

## Shell Data Flow

1. `Bash` validates the platform-neutral request.
2. `LocalShellBackend` asks the shell resolver for the configured Bash executable.
3. The process controller builds platform-correct creation options.
4. `ShellSessionManager` registers the process only after successful creation.
5. Output readers append stdout and stderr to the existing bounded buffers.
6. Foreground execution waits for completion; background execution returns the existing shell snapshot.
7. Timeout, interrupt, and `KillShell` all call the same process-tree termination operation.
8. Final process state, exit code, output counts, and cleanup result flow through the current lifecycle and notification protocols.

If process creation fails, no shell ID is registered. If termination fails, the registry retains the observed running state and returns a concrete error instead of claiming that the process ended.

## Configuration

Add a `shell_path` user setting with the `MYCLI_SHELL_PATH` environment override for source-checkout and CI use. The environment variable takes precedence over the TOML setting.

Configuration behavior:

- an explicit path must exist and be executable enough for `subprocess` to launch;
- invalid explicit configuration fails with the configured path in the diagnostic;
- automatic Windows discovery reports all checked Git Bash locations;
- missing Windows Bash does not prevent non-shell startup, print mode, session inspection, or settings access;
- the first shell invocation returns an actionable installation/configuration error.

## Paths And Environment

Python code continues to use `pathlib.Path` and native host paths. `subprocess` receives a native Windows `cwd` when running on Windows.

Command strings are not globally rewritten from Windows paths to POSIX paths. Rewriting arbitrary Bash text would corrupt quoting, URLs, regular expressions, and commands produced by the model. Tools that insert a concrete host path into a Bash command must quote or convert that path at the tool boundary when necessary.

PATH handling must be case-insensitive on Windows. The runtime must update the existing PATH key regardless of whether the environment uses `PATH`, `Path`, or another case variant. Bundled ripgrep selection continues to use `rg.exe` on Windows.

## Filesystem Permissions

POSIX permission hardening remains unchanged on Linux and macOS. Operations such as `chmod(0o600)` and `chmod(0o700)` move behind a best-effort helper:

- apply permissions normally on POSIX;
- on Windows, do not fail startup or settings persistence because POSIX mode bits are unsupported or ineffective;
- continue to avoid logging secrets or file contents in permission diagnostics.

This is a compatibility boundary, not a complete Windows ACL implementation.

## Node TUI Adaptation

### Launch command

The Python launcher selects the platform-correct local executable:

- Unix: `node_modules/.bin/tsx`;
- Windows: `node_modules/.bin/tsx.cmd`.

Node itself remains discoverable through PATH, and Node version validation remains platform-neutral.

### Terminal behavior

mycli may start from PowerShell, CMD, Windows Terminal, or Git Bash. The TUI requires an interactive terminal with raw input support. Startup performs an explicit capability check and returns a clear error when raw mode or a usable TTY is unavailable. Print and RPC modes do not require the full-screen TUI terminal capability.

Platform-specific signal registration must be conditional. Suspend/resume behavior that depends on SIGTSTP is unavailable on Windows and must not be registered there. Resize handling continues through Node stream resize events where supported.

### Clipboard

Move clipboard behavior to a platform utility:

- macOS: `pbcopy`;
- Linux: prefer `wl-copy`, then `xclip` or `xsel` when available;
- Windows: `clip.exe`.

Clipboard failure is non-fatal and returns a false capability result without interrupting the TUI.

### Key labels

Existing macOS `alt` to `option` display behavior remains. Windows and Linux retain `alt`. Platform-specific shortcuts are declared in one keybinding/platform boundary rather than repeated in components.

## Source-Checkout Development

The supported first-release installation flow is a repository checkout with Python and Node dependencies installed locally.

Documentation must provide commands for:

- Linux/macOS setup with Python 3.13, uv, Node 22.19+, and npm;
- Windows setup from PowerShell, including Git for Windows and the same Python/Node requirements;
- Git Bash discovery diagnostics and `shell_path` override;
- running Python tests and Node TUI tests on each platform.

Repository scripts and documentation must avoid assuming a POSIX shell when an equivalent cross-platform command is practical. Existing shell-only maintenance scripts may remain documented as Git Bash requirements on Windows.

## Error Handling

- Missing Git Bash produces an actionable shell-resolution error with installation and configuration instructions.
- Invalid `shell_path` identifies the configured path and does not silently fall back.
- Failed process creation does not create registry state.
- Failed process-tree termination reports the observed process state and cleanup error.
- TUI launch without raw terminal support returns a clear error and restores terminal state when partially initialized.
- Missing clipboard commands degrade silently.
- Permission hardening failures are non-fatal on Windows and diagnosable without exposing sensitive data.
- Platform adapters must not catch broad exceptions at business-logic boundaries when a specific failure can be represented.

## Testing Strategy

### Unit tests

- shell resolver order for Linux, macOS, and Windows;
- explicit shell path success and failure;
- case-insensitive Windows PATH handling;
- platform-correct process creation options;
- platform-correct process-tree termination escalation;
- absence of POSIX-only signal access on Windows branches;
- best-effort permission handling;
- `tsx` versus `tsx.cmd` launcher selection;
- clipboard command selection and graceful failure;
- TTY capability diagnostics;
- platform-specific key labels.

Platform-dependent functions accept injected platform and OS operations so Windows branches run on Linux/macOS CI workers and vice versa.

### Integration and smoke tests

Each platform verifies:

- foreground Bash command and output;
- non-zero exit status;
- background Bash creation;
- incremental `BashOutput` polling;
- timeout;
- runtime interruption;
- explicit `KillShell` termination;
- Node TUI typecheck and automated tests;
- Python test suite, Ruff, and Mypy.

Windows smoke tests use Git for Windows Bash and do not rely on WSL.

### GitHub Actions

Add a matrix using:

- `ubuntu-latest`;
- `macos-latest`;
- `windows-latest`.

The workflow installs Python 3.13, uv, Node 22.19+, Python dependencies, and Node TUI dependencies. It runs Python and Node quality gates on all three systems, with platform-specific shell smoke tests guarded only where unavoidable.

## Compatibility And Migration

Existing Linux and macOS defaults remain compatible. No session, SQLite, or tool protocol migration is required. Shell IDs and lifecycle payloads remain unchanged.

The new shell path setting is optional. Existing users continue to receive automatic shell resolution. Windows users gain Git Bash discovery without needing to launch mycli from Git Bash.

## Acceptance Criteria

- mycli starts from a repository checkout on Linux, macOS, PowerShell, CMD, Windows Terminal, and Git Bash when dependencies are installed.
- Windows agent shell commands execute through Git Bash with Bash syntax.
- foreground, background, polling, timeout, interruption, and termination behavior work on all three operating systems.
- no Windows code path imports or accesses unsupported POSIX signal/process APIs.
- settings and auth persistence do not fail solely because POSIX chmod semantics are unavailable.
- the Node TUI uses the correct local executable and provides actionable TTY errors.
- clipboard copy works when a supported platform command exists and otherwise degrades without breaking the TUI.
- Linux, macOS, and Windows CI all run Python and Node quality gates plus shell lifecycle smoke coverage.
- existing shell IDs, lifecycle events, and public tool contracts remain backward compatible.
