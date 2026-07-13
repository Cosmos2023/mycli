# mycli Cross-Platform Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a source checkout of mycli run on Linux, macOS, and native Windows, using Git Bash for all Windows agent shell commands and preserving the complete foreground/background shell lifecycle.

**Architecture:** Add typed shell-resolution and process-control boundaries under `mycli.tools`, then thread the resolved shell path through the existing execution-policy and shell-backend contracts. Keep shell IDs, lifecycle payloads, and tool APIs unchanged. Add narrow platform utilities for permissions, Node TUI launch/TTY behavior, and clipboard access, with a Linux/macOS/Windows CI matrix proving the supported source-checkout workflow.

**Tech Stack:** Python 3.13, `subprocess`, `pathlib`, pytest, uv, Ruff, Mypy, Node.js 22.19+, TypeScript 5.9, Node test runner, GitHub Actions.

---

## File Map

- Create `src/mycli/tools/shell_resolver.py`: typed Linux/macOS/Windows Bash discovery and actionable diagnostics.
- Create `tests/unit/tools/test_shell_resolver.py`: injected-platform resolver coverage.
- Modify `src/mycli/domain/runtime/__init__.py`: add `AgentConfig.shell_path`.
- Modify `src/mycli/domain/runtime/execution_policy.py`: add `ShellExecutionOptions.shell_path`.
- Modify `src/mycli/config/settings.py`: resolve `MYCLI_SHELL_PATH` and `shell_path` with environment precedence.
- Modify `src/mycli/application/runtime/tools/runtime_policy.py`: carry `shell_path` from `RuntimePolicyGate` into `ShellExecutionOptions`.
- Modify `src/mycli/application/runtime/agent_runtime.py`: pass configured `shell_path` into runtime policy creation.
- Modify `src/mycli/tools/shell_backend.py`: carry `shell_path` through the backend request.
- Modify `src/mycli/tools/bash.py`: pass `shell_path` into `execute_bash()` and the session manager.
- Create `src/mycli/tools/process_controller.py`: platform-correct spawn options and process-tree termination.
- Create `tests/unit/tools/test_process_controller.py`: simulated Unix and Windows process behavior.
- Modify `src/mycli/tools/shell_session_manager.py`: use shell resolver and process controller instead of `shell=True`, `$SHELL`, and inline POSIX signals.
- Modify `tests/unit/tools/test_shell_session_manager.py`: preserve lifecycle contracts and add platform-adapter integration tests.
- Modify `tests/unit/tools/test_run_shell.py`: foreground, timeout, and interrupt regression coverage through the new backend.
- Create `src/mycli/config/file_permissions.py`: best-effort POSIX permission hardening.
- Create `tests/unit/config/test_file_permissions.py`: POSIX and Windows permission behavior.
- Modify `src/mycli/config/auth_store.py`: use permission helper.
- Modify `src/mycli/config/shell_settings.py`: use permission helper and persist `shell_path` when supplied by settings surfaces.
- Modify `src/mycli/tools/shell_environment.py`: update the existing case-insensitive PATH key on Windows.
- Modify `tests/unit/tools/test_shell_environment.py`: Windows `Path` casing coverage.
- Modify `src/mycli/services/diagnostics/doctor.py`: report the same resolved Bash used by runtime execution.
- Modify `tests/unit/services/test_doctor_service.py`: injected Windows and missing-shell diagnostics.
- Modify `src/mycli/tools/lint.py`: execute detected linter strings through the shared Bash resolver without `shell=True`.
- Modify `tests/unit/test_lint.py`: assert explicit `<bash> -c <command>` execution.
- Modify `src/mycli/services/hooks/config.py`: resolve string hook commands through the shared Bash resolver instead of hard-coded `sh`.
- Modify `tests/unit/services/test_configured_hooks.py`: injected resolver coverage for string hooks.
- Create `tests/support/shell_commands.py`: Windows-safe Python command construction for shell lifecycle tests.
- Modify shell lifecycle tests using hard-coded `python3` to use the shared test helper.
- Modify `src/mycli/cli/node_tui/process.py`: select `tsx.cmd` on Windows.
- Modify `tests/unit/cli/node_tui/test_process.py`: Windows Node launcher coverage.
- Modify `tui/mycli-shell/src/adapters/tty-terminal.ts`: use stdio TTY streams on Windows and `/dev/tty` on Unix.
- Modify `tui/mycli-shell/test/tty-terminal.test.ts`: platform-injected TTY capability tests.
- Create `tui/mycli-shell/src/adapters/clipboard.ts`: macOS/Linux/Windows text clipboard selection.
- Create `tui/mycli-shell/test/clipboard.test.ts`: clipboard command and degradation tests.
- Modify `tui/mycli-shell/src/components/keybinding-hints.ts`: inject the display platform at the key-label boundary.
- Create `tui/mycli-shell/test/keybinding-hints.test.ts`: macOS `option` and Linux/Windows `alt` label tests.
- Modify `tui/mycli-shell/src/shell-runtime.ts`: call the clipboard adapter.
- Create `.github/workflows/cross-platform.yml`: Python and Node quality gates on Ubuntu, macOS, and Windows.
- Modify `README.md`: source-checkout prerequisites and platform setup.
- Create `docs/windows.md`: Git Bash discovery, configuration, and troubleshooting.
- Modify `docs/superpowers/specs/README.md`: index the cross-platform design and implementation plan.

## Task 1: Add Typed Cross-Platform Shell Resolution

**Files:**
- Create: `src/mycli/tools/shell_resolver.py`
- Create: `tests/unit/tools/test_shell_resolver.py`

- [ ] **Step 1: Write failing resolver tests**

```python
from pathlib import Path

import pytest

from mycli.tools.shell_resolver import ShellResolutionError, resolve_shell


def test_windows_prefers_explicit_shell_path() -> None:
    explicit = Path(r"D:\tools\bash.exe")
    resolved = resolve_shell(
        custom_shell_path=str(explicit),
        platform_name="win32",
        env={"ProgramFiles": r"C:\Program Files"},
        path_exists=lambda path: path == explicit,
        which=lambda _name, _path: None,
    )
    assert resolved.executable == explicit
    assert resolved.args == ("-c",)


def test_windows_finds_git_bash_before_path() -> None:
    git_bash = Path(r"C:\Program Files\Git\bin\bash.exe")
    resolved = resolve_shell(
        custom_shell_path=None,
        platform_name="win32",
        env={"ProgramFiles": r"C:\Program Files", "PATH": r"C:\bin"},
        path_exists=lambda path: path == git_bash,
        which=lambda _name, _path: r"C:\bin\bash.exe",
    )
    assert resolved.executable == git_bash


def test_windows_missing_bash_has_actionable_error() -> None:
    with pytest.raises(ShellResolutionError, match="Install Git for Windows"):
        resolve_shell(
            custom_shell_path=None,
            platform_name="win32",
            env={"ProgramFiles": r"C:\Program Files"},
            path_exists=lambda _path: False,
            which=lambda _name, _path: None,
        )


@pytest.mark.parametrize("platform_name", ["linux", "darwin"])
def test_unix_falls_back_from_bin_bash_to_path(platform_name: str) -> None:
    resolved = resolve_shell(
        custom_shell_path=None,
        platform_name=platform_name,
        env={"PATH": "/custom/bin"},
        path_exists=lambda _path: False,
        which=lambda name, _path: "/custom/bin/bash" if name == "bash" else None,
    )
    assert resolved.executable == Path("/custom/bin/bash")
    assert resolved.args == ("-c",)
```

- [ ] **Step 2: Run the resolver tests to verify RED**

Run:

```bash
uv run pytest tests/unit/tools/test_shell_resolver.py -q
```

Expected: collection fails because `mycli.tools.shell_resolver` does not exist.

- [ ] **Step 3: Implement the resolver**

Create this public boundary:

```python
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import shutil
import sys
from typing import Callable, Mapping


@dataclass(frozen=True, slots=True)
class ShellCommandConfig:
    executable: Path
    args: tuple[str, ...] = ("-c",)


class ShellResolutionError(RuntimeError):
    pass


PathExists = Callable[[Path], bool]
WhichExecutable = Callable[[str, str | None], str | None]


def resolve_shell(
    custom_shell_path: str | None,
    *,
    platform_name: str = sys.platform,
    env: Mapping[str, str] = os.environ,
    path_exists: PathExists = Path.exists,
    which: WhichExecutable = lambda name, path: shutil.which(name, path=path),
) -> ShellCommandConfig:
    if custom_shell_path:
        explicit = Path(custom_shell_path).expanduser()
        if path_exists(explicit):
            return ShellCommandConfig(explicit)
        raise ShellResolutionError(f"Configured shell_path does not exist: {explicit}")
    if platform_name == "win32":
        candidates = _windows_git_bash_candidates(env)
        for candidate in candidates:
            if path_exists(candidate):
                return ShellCommandConfig(candidate)
        on_path = which("bash.exe", _environment_path(env))
        if on_path:
            return ShellCommandConfig(Path(on_path))
        searched = "\n".join(f"  {candidate}" for candidate in candidates)
        raise ShellResolutionError(
            "No Bash executable was found. Install Git for Windows or set "
            "MYCLI_SHELL_PATH/shell_path.\nSearched:\n" + searched
        )
    bin_bash = Path("/bin/bash")
    if path_exists(bin_bash):
        return ShellCommandConfig(bin_bash)
    on_path = which("bash", _environment_path(env))
    if on_path:
        return ShellCommandConfig(Path(on_path))
    return ShellCommandConfig(Path("sh"))
```

Implement `_windows_git_bash_candidates()` using `ProgramFiles` and `ProgramFiles(x86)`. Implement `_environment_path()` with case-insensitive PATH lookup so Windows `Path` is accepted.

- [ ] **Step 4: Run focused tests and static checks**

```bash
uv run pytest tests/unit/tools/test_shell_resolver.py -q
uv run ruff check src/mycli/tools/shell_resolver.py tests/unit/tools/test_shell_resolver.py
uv run mypy src/mycli/tools/shell_resolver.py
```

Expected: all resolver tests pass, Ruff reports no errors, and Mypy succeeds.

- [ ] **Step 5: Commit the resolver**

```bash
git add src/mycli/tools/shell_resolver.py tests/unit/tools/test_shell_resolver.py
git commit -m "Add cross-platform shell resolution"
```

## Task 2: Thread `shell_path` Through Runtime Configuration

**Files:**
- Modify: `src/mycli/domain/runtime/__init__.py:183-244`
- Modify: `src/mycli/domain/runtime/execution_policy.py:193-225`
- Modify: `src/mycli/config/settings.py:398-870`
- Modify: `src/mycli/application/runtime/tools/runtime_policy.py:34-230`
- Modify: `src/mycli/application/runtime/agent_runtime.py:390-425`
- Modify: `src/mycli/tools/shell_backend.py:15-61`
- Modify: `src/mycli/tools/bash.py:1-370`
- Modify: `tests/unit/services/test_config_service.py`
- Modify: `tests/unit/tools/test_run_shell.py`

- [ ] **Step 1: Write failing configuration precedence tests**

```python
def test_shell_path_environment_overrides_user_and_project_config(tmp_path: Path) -> None:
    home = tmp_path / "home"
    cwd = tmp_path / "repo"
    (home / ".mycli").mkdir(parents=True)
    (cwd / ".mycli").mkdir(parents=True)
    (home / ".mycli" / "config.toml").write_text(
        'shell_path = "/user/bash"\n', encoding="utf-8"
    )
    (cwd / ".mycli" / "config.toml").write_text(
        'shell_path = "/project/bash"\n', encoding="utf-8"
    )
    config = resolve_config(
        {},
        {"MYCLI_API_KEY": "test", "MYCLI_SHELL_PATH": "/env/bash"},
        cwd,
        home,
    )
    assert config.shell_path == "/env/bash"


def test_shell_path_project_config_precedes_legacy_config(tmp_path: Path) -> None:
    home = tmp_path / "home"
    cwd = tmp_path / "repo"
    (home / ".config" / "mycli").mkdir(parents=True)
    (cwd / ".mycli").mkdir(parents=True)
    (home / ".config" / "mycli" / "config.toml").write_text(
        'shell_path = "/legacy/bash"\n', encoding="utf-8"
    )
    (cwd / ".mycli" / "config.toml").write_text(
        'shell_path = "/project/bash"\n', encoding="utf-8"
    )
    config = resolve_config(
        {},
        {"MYCLI_API_KEY": "test"},
        cwd,
        home,
    )
    assert config.shell_path == "/project/bash"


def test_execute_bash_forwards_configured_shell_path(tmp_path: Path) -> None:
    captured: list[ShellBackendRequest] = []

    class CapturingBackend:
        @property
        def profile(self) -> ShellBackendProfile:
            return ShellBackendProfile()

        def execute(self, request: ShellBackendRequest) -> dict[str, object]:
            captured.append(request)
            return {"success": True, "status": "completed", "output": "ok"}

    execute_bash(
        "printf ok",
        workdir=str(tmp_path),
        shell_path="/configured/bash",
        backend=CapturingBackend(),
    )
    assert captured[0].shell_path == "/configured/bash"
```

- [ ] **Step 2: Run tests to verify RED**

```bash
uv run pytest tests/unit/services/test_config_service.py -k shell_path -q
uv run pytest tests/unit/tools/test_run_shell.py -k shell_path -q
```

Expected: failures because `AgentConfig`, `ShellExecutionOptions`, and `ShellBackendRequest` do not expose `shell_path`.

- [ ] **Step 3: Add typed configuration fields**

Add these fields:

```python
# AgentConfig
shell_path: str | None = None

# ShellExecutionOptions
shell_path: str | None = None

# ShellBackendRequest
shell_path: str | None = None
```

Resolve the value in `resolve_config()` with `_config_value()`:

```python
shell_path_value = _config_value(
    env=env,
    user_config=user_config,
    project_config=project_config,
    legacy_user_config=legacy_user_config,
    env_key="MYCLI_SHELL_PATH",
    config_key="shell_path",
)
```

Set `AgentConfig.shell_path` to the stripped non-empty string or `None`. Add `shell_path` to `RuntimePolicyGate.__init__()`, pass it from `AgentRuntime`, and include it in `RuntimePolicyGate.shell_execution_options()` through `ShellExecutionOptions.from_policy()`. `ToolExecutionService` already injects that object into Bash arguments as `_runtime_shell_options`; read `shell_options.shell_path` in `BashTool` and pass it through `ShellBackendRequest`. Also add `shell_path` to direct `execute_bash()` calls for tests and non-agent callers.

Extend `ShellExecutionOptions.to_trace_payload()` with the boolean field `custom_shell_path: self.shell_path is not None`; never put the local path itself into model-visible content.

- [ ] **Step 4: Run configuration and shell forwarding tests**

```bash
uv run pytest tests/unit/services/test_config_service.py -k shell_path -q
uv run pytest tests/unit/tools/test_run_shell.py -k shell_path -q
uv run pytest tests/unit/domain/runtime/test_execution_policy.py -q
uv run ruff check src/mycli/domain/runtime/__init__.py \
  src/mycli/domain/runtime/execution_policy.py \
  src/mycli/config/settings.py \
  src/mycli/application/runtime/tools/runtime_policy.py \
  src/mycli/application/runtime/agent_runtime.py \
  src/mycli/tools/shell_backend.py src/mycli/tools/bash.py
uv run mypy src/mycli/domain/runtime src/mycli/config/settings.py \
  src/mycli/application/runtime/tools/runtime_policy.py \
  src/mycli/application/runtime/agent_runtime.py \
  src/mycli/tools/shell_backend.py src/mycli/tools/bash.py
```

Expected: focused tests and static checks pass.

- [ ] **Step 5: Commit configuration plumbing**

```bash
git add src/mycli/domain/runtime/__init__.py \
  src/mycli/domain/runtime/execution_policy.py \
  src/mycli/config/settings.py \
  src/mycli/application/runtime/tools/runtime_policy.py \
  src/mycli/application/runtime/agent_runtime.py \
  src/mycli/tools/shell_backend.py src/mycli/tools/bash.py \
  tests/unit/services/test_config_service.py tests/unit/tools/test_run_shell.py
git commit -m "Configure the cross-platform shell path"
```

## Task 3: Add A Platform Process Controller

**Files:**
- Create: `src/mycli/tools/process_controller.py`
- Create: `tests/unit/tools/test_process_controller.py`

- [ ] **Step 1: Write failing spawn and termination tests**

Use fake `Popen` objects and injected operations to assert:

```python
def test_unix_spawn_options_create_a_new_session() -> None:
    options = process_spawn_options(platform_name="linux")
    assert options == {"start_new_session": True}


def test_windows_spawn_options_create_a_new_process_group() -> None:
    options = process_spawn_options(platform_name="win32")
    assert options["creationflags"] & WINDOWS_CREATE_NEW_PROCESS_GROUP
    assert "start_new_session" not in options


def test_windows_termination_uses_ctrl_break_then_taskkill() -> None:
    process = FakeProcess(pid=1234, polls=[None, None, 1])
    commands: list[list[str]] = []
    outcome = terminate_process_tree(
        process,
        prefer_interrupt=True,
        platform_name="win32",
        taskkill=lambda command: commands.append(command),
    )
    assert process.sent_signals == [WINDOWS_CTRL_BREAK_EVENT]
    assert commands == [["taskkill", "/PID", "1234", "/T", "/F"]]
    assert outcome.terminal is True


def test_unix_termination_targets_process_group() -> None:
    sent: list[tuple[int, int]] = []
    process = FakeProcess(pid=44, polls=[None, 0])
    outcome = terminate_process_tree(
        process,
        prefer_interrupt=True,
        platform_name="linux",
        killpg=lambda pid, sig: sent.append((pid, sig)),
    )
    assert sent[0] == (44, signal.SIGINT)
    assert outcome.cleanup_result == "sent_sigint"
```

- [ ] **Step 2: Run tests to verify RED**

```bash
uv run pytest tests/unit/tools/test_process_controller.py -q
```

Expected: collection fails because `process_controller` does not exist.

- [ ] **Step 3: Implement the process controller**

Create:

```python
from dataclasses import dataclass
import os
import signal
import subprocess
import sys
from typing import Callable

WINDOWS_CREATE_NEW_PROCESS_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
WINDOWS_CTRL_BREAK_EVENT = getattr(signal, "CTRL_BREAK_EVENT", 1)


@dataclass(frozen=True, slots=True)
class ProcessTerminationOutcome:
    cleanup_result: str
    terminal: bool
    error: str | None = None


def process_spawn_options(*, platform_name: str = sys.platform) -> dict[str, object]:
    if platform_name == "win32":
        return {"creationflags": WINDOWS_CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}
```

Implement `terminate_process_tree()` with this sequence:

- return `already_exited` when `poll()` is non-`None`;
- Unix: SIGINT when requested, then SIGTERM, then SIGKILL, targeting `os.killpg()` and waiting after each signal;
- Windows: `send_signal(CTRL_BREAK_EVENT)` when requested, then `terminate()`, then `taskkill /PID <pid> /T /F` through an injected runner;
- after each stage, re-check `poll()` and return the observed terminal state;
- convert permission/process lookup/timeouts to structured outcomes instead of raising from cleanup.

- [ ] **Step 4: Run controller tests and static checks**

```bash
uv run pytest tests/unit/tools/test_process_controller.py -q
uv run ruff check src/mycli/tools/process_controller.py tests/unit/tools/test_process_controller.py
uv run mypy src/mycli/tools/process_controller.py
```

Expected: all tests pass and static checks succeed on the current host while exercising both platforms through injection.

- [ ] **Step 5: Commit the process controller**

```bash
git add src/mycli/tools/process_controller.py tests/unit/tools/test_process_controller.py
git commit -m "Add cross-platform process control"
```

## Task 4: Integrate The Resolver And Controller Into Shell Sessions

**Files:**
- Modify: `src/mycli/tools/shell_session_manager.py:25-185,807-839`
- Modify: `src/mycli/tools/shell_backend.py:15-61`
- Modify: `src/mycli/tools/bash.py:40-170`
- Modify: `tests/unit/tools/test_shell_session_manager.py`
- Modify: `tests/unit/tools/test_run_shell.py`
- Modify: `tests/unit/tools/test_bash_output.py`
- Modify: `tests/unit/test_kill_shell.py`

- [ ] **Step 1: Write failing manager integration tests**

Add an injected resolver and controller to the manager constructor and test:

```python
from unittest.mock import Mock


def test_manager_spawns_resolved_shell_without_shell_true(tmp_path: Path) -> None:
    factory = Mock(side_effect=OSError("stop after capture"))
    manager = ShellSessionManager(
        shell_resolver=lambda _path: ShellCommandConfig(Path("/custom/bash")),
        process_factory=factory,
    )
    result = manager.start(
        ShellStartRequest(
            owner_session_id="session-a",
            command="printf ok",
            cwd=tmp_path,
            timeout_seconds=30,
            background=True,
            shell_path="/custom/bash",
        )
    )
    assert result.error_kind == "shell_spawn_failed"
    args, kwargs = factory.call_args
    assert args[0] == ["/custom/bash", "-c", "printf ok"]
    assert "shell" not in kwargs


def test_manager_does_not_register_failed_shell_resolution(tmp_path: Path) -> None:
    def missing_shell(_path: str | None) -> ShellCommandConfig:
        raise ShellResolutionError("Install Git for Windows")

    manager = ShellSessionManager(shell_resolver=missing_shell)
    result = manager.start(
        ShellStartRequest(
            owner_session_id="session-a",
            command="printf ok",
            cwd=tmp_path,
            timeout_seconds=30,
            background=True,
        )
    )
    assert result.error_kind == "shell_resolution_failed"
    assert manager.list_sessions("session-a") == ()
```

Add regression assertions that timeout, interrupt, and `KillShell` call the injected process controller and retain existing `terminal_state`/`cleanup_result` values.

- [ ] **Step 2: Run integration tests to verify RED**

```bash
uv run pytest tests/unit/tools/test_shell_session_manager.py -k "resolved_shell or resolution or process_controller" -q
uv run pytest tests/unit/tools/test_run_shell.py -k "timeout or interrupt" -q
uv run pytest tests/unit/tools/test_bash_output.py tests/unit/test_kill_shell.py -q
```

Expected: new manager-constructor and request arguments are unsupported.

- [ ] **Step 3: Replace inline process mechanics**

Add `shell_path: str | None = None` to `ShellStartRequest`. Add injectable constructor arguments with production defaults:

```python
ShellResolver = Callable[[str | None], ShellCommandConfig]
ProcessFactory = Callable[..., subprocess.Popen[str]]
ProcessTerminator = Callable[[subprocess.Popen[str], bool], ProcessTerminationOutcome]


def __init__(
    self,
    *,
    shell_resolver: ShellResolver = lambda path: resolve_shell(path),
    process_factory: ProcessFactory = subprocess.Popen,
    process_terminator: ProcessTerminator = _default_process_terminator,
) -> None:
```

Add these three keyword-only parameters to the existing constructor without changing the existing capacity/output parameters.

In `start()`:

```python
try:
    shell = self._shell_resolver(request.shell_path)
    process = self._process_factory(
        [str(shell.executable), *shell.args, request.command],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
        cwd=request.cwd,
        env=request.env,
        bufsize=1,
        **process_spawn_options(),
    )
except ShellResolutionError as exc:
    self._release_capacity_reservation()
    return self._error_snapshot(
        owner_session_id=request.owner_session_id,
        error_kind="shell_resolution_failed",
        error=str(exc),
    )
except OSError as exc:
    self._release_capacity_reservation()
    return self._error_snapshot(
        owner_session_id=request.owner_session_id,
        error_kind="shell_spawn_failed",
        error=str(exc),
    )
```

Replace `_terminate_process_group()` calls with the injected controller. Update session cleanup from the structured outcome and preserve an active session when `terminal` is false.

Thread `request.shell_path` from `ShellBackendRequest` through `execute_bash()` into `ShellStartRequest`.

- [ ] **Step 4: Run complete shell tests**

```bash
uv run pytest tests/unit/tools/test_shell_session_manager.py \
  tests/unit/tools/test_run_shell.py \
  tests/unit/tools/test_bash_output.py \
  tests/unit/test_kill_shell.py \
  tests/unit/test_bash.py -q
uv run ruff check src/mycli/tools/shell_session_manager.py \
  src/mycli/tools/shell_backend.py src/mycli/tools/bash.py \
  tests/unit/tools/test_shell_session_manager.py
uv run mypy src/mycli/tools/shell_session_manager.py \
  src/mycli/tools/shell_backend.py src/mycli/tools/bash.py
```

Expected: existing and new shell lifecycle tests pass without changing public tool payloads.

- [ ] **Step 5: Commit shell integration**

```bash
git add src/mycli/tools/shell_session_manager.py \
  src/mycli/tools/shell_backend.py src/mycli/tools/bash.py \
  tests/unit/tools/test_shell_session_manager.py \
  tests/unit/tools/test_run_shell.py \
  tests/unit/tools/test_bash_output.py tests/unit/test_kill_shell.py
git commit -m "Run shell sessions across supported platforms"
```

## Task 5: Make Permissions And Environment Handling Platform-Safe

**Files:**
- Create: `src/mycli/config/file_permissions.py`
- Create: `tests/unit/config/test_file_permissions.py`
- Modify: `src/mycli/config/auth_store.py:35-60`
- Modify: `src/mycli/config/shell_settings.py:49-89`
- Create: `tests/unit/config/test_shell_settings.py`
- Modify: `src/mycli/tools/shell_environment.py:18-43`
- Modify: `tests/unit/tools/test_shell_environment.py`

- [ ] **Step 1: Write failing permission and PATH tests**

```python
def test_harden_private_path_applies_posix_mode(tmp_path: Path) -> None:
    target = tmp_path / "secret"
    target.write_text("x", encoding="utf-8")
    harden_private_path(target, mode=0o600, os_name="posix")
    assert stat.S_IMODE(target.stat().st_mode) == 0o600


def test_harden_private_path_ignores_windows_chmod_failure(tmp_path: Path) -> None:
    calls: list[int] = []

    def failing_chmod(_path: Path, mode: int) -> None:
        calls.append(mode)
        raise OSError("Windows ACL does not expose POSIX mode bits")

    harden_private_path(
        tmp_path / "secret",
        mode=0o600,
        os_name="nt",
        chmod=failing_chmod,
    )
    assert calls == [0o600]


def test_shell_environment_updates_existing_windows_path_key() -> None:
    env = create_shell_environment(
        ShellEnvironmentPolicy.inherit_all(),
        source_env={"Path": r"C:\Windows", "HOME": r"C:\Users\demo"},
    )
    assert "Path" in env
    assert "PATH" not in env
```

- [ ] **Step 2: Run tests to verify RED**

```bash
uv run pytest tests/unit/config/test_file_permissions.py \
  tests/unit/tools/test_shell_environment.py -q
```

Expected: missing helper and current hard-coded `PATH` behavior fail.

- [ ] **Step 3: Implement compatibility helpers**

Create:

```python
def harden_private_path(
    path: Path,
    *,
    mode: int,
    os_name: str = os.name,
    chmod: Callable[[Path, int], None] = lambda target, value: target.chmod(value),
) -> None:
    try:
        chmod(path, mode)
    except OSError:
        if os_name != "nt":
            raise
```

Use it for auth directories/files and shell settings. In `create_shell_environment()`, locate the existing key with `key.lower() == "path"`, update that key, and create `PATH` only when no variant exists.

- [ ] **Step 4: Run focused tests and static checks**

```bash
uv run pytest tests/unit/config/test_file_permissions.py \
  tests/unit/tools/test_shell_environment.py \
  tests/unit/config/test_auth_store.py \
  tests/unit/config/test_shell_settings.py -q
uv run ruff check src/mycli/config/file_permissions.py \
  src/mycli/config/auth_store.py src/mycli/config/shell_settings.py \
  src/mycli/tools/shell_environment.py
uv run mypy src/mycli/config/file_permissions.py \
  src/mycli/config/auth_store.py src/mycli/config/shell_settings.py \
  src/mycli/tools/shell_environment.py
```

Expected: tests and static checks pass.

- [ ] **Step 5: Commit platform-safe persistence**

```bash
git add src/mycli/config/file_permissions.py \
  src/mycli/config/auth_store.py src/mycli/config/shell_settings.py \
  src/mycli/tools/shell_environment.py \
  tests/unit/config/test_file_permissions.py \
  tests/unit/config/test_shell_settings.py tests/unit/tools/test_shell_environment.py
git commit -m "Handle platform filesystem differences"
```

## Task 6: Route Every Shell Consumer Through The Resolver

**Files:**
- Modify: `src/mycli/services/diagnostics/doctor.py:1306-1335,2236-2265`
- Modify: `tests/unit/services/test_doctor_service.py`
- Modify: `src/mycli/tools/lint.py:1-55`
- Modify: `tests/unit/test_lint.py`
- Modify: `src/mycli/services/hooks/config.py:90-170,246-325`
- Modify: `src/mycli/services/hooks/setup.py:16-35`
- Modify: `src/mycli/services/hooks/management.py:79-215`
- Modify: `src/mycli/cli/main.py:155-215`
- Modify: `tests/unit/services/test_configured_hooks.py`
- Modify: `tests/unit/services/test_hook_management.py`
- Modify: `src/mycli/services/write_diagnostics.py:9-25`
- Modify: `src/mycli/application/runtime/agent_runtime.py:345-365,440-460,1047-1065`
- Create: `tests/support/shell_commands.py`
- Modify: `tests/unit/application/test_agent_runtime.py`
- Modify: `tests/unit/application/test_tool_execution_service.py`
- Modify: `tests/unit/test_bash.py`
- Modify: `tests/unit/tools/test_run_shell.py`
- Modify: `tests/unit/tools/test_bash_output.py`
- Modify: `tests/unit/tools/test_shell_session_manager.py`

- [ ] **Step 1: Write failing doctor, lint, and hook tests**

Add resolver injection tests that prove all three consumers use the same typed shell command:

```python
def test_lint_runs_through_resolved_bash_without_shell_true(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[tool.ruff]", encoding="utf-8")
    completed = subprocess.CompletedProcess([], 0, stdout="[]", stderr="")
    with patch("mycli.tools.lint.subprocess.run", return_value=completed) as run:
        lint(cwd=tmp_path, shell_resolver=lambda _path: ShellCommandConfig(Path("/custom/bash")))
    args, kwargs = run.call_args
    assert args[0] == ["/custom/bash", "-c", "ruff check --output-format json"]
    assert "shell" not in kwargs


def test_string_hook_uses_resolved_bash(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.joinpath(".mycli").mkdir(parents=True)
    workspace.joinpath(".mycli", "hooks.json").write_text(
        json.dumps(
            {
                "hooks": [
                    {
                        "id": "repo-command",
                        "hook_point": "pre_tool_use",
                        "command": "echo '{}'",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    registry = HookConfigRegistry(
        workspace_root=workspace,
        home_dir=tmp_path / "home",
        shell_resolver=lambda _path: ShellCommandConfig(Path("/custom/bash")),
    )
    discovery = registry.discover()
    assert discovery.hooks[0].command == ("/custom/bash", "-c", "echo '{}'")


def test_doctor_uses_windows_shell_resolver(tmp_path: Path) -> None:
    resolved = ShellCommandConfig(Path(r"C:\Program Files\Git\bin\bash.exe"))
    report = DoctorService(
        workspace_root=tmp_path,
        home_dir=tmp_path,
        env={"ProgramFiles": r"C:\Program Files"},
        shell_resolver=lambda _path: resolved,
        which=lambda command: "git" if command == "git" else None,
    ).run()
    check = next(item for item in report.checks if item.name == "tool_environment")
    assert check.status is DoctorStatus.OK
    assert str(resolved.executable) in check.detail
```

- [ ] **Step 2: Run focused tests to verify RED**

```bash
uv run pytest tests/unit/test_lint.py \
  tests/unit/services/test_configured_hooks.py \
  tests/unit/services/test_doctor_service.py -q
```

Expected: tests fail because these consumers still use `shell=True`, `sh`, or `$SHELL` directly and do not accept resolver injection.

- [ ] **Step 3: Replace independent shell selection**

In `lint()`, add a `shell_path` argument and injected `shell_resolver`, resolve once, and call:

```python
shell = shell_resolver(shell_path)
subprocess.run(
    [str(shell.executable), *shell.args, effective_command],
    capture_output=True,
    text=True,
    timeout=60,
    cwd=root,
    check=False,
)
```

Add `shell_path` and `shell_resolver` injection to `HookConfigRegistry`; pass both into `_parse_hook()` and `_parse_command()`. String hook commands become `(str(shell.executable), *shell.args, script)`, while list commands remain unchanged. Convert `ShellResolutionError` into a `HookConfigIssue` containing the resolver's actionable message. Thread `config.shell_path` through `register_configured_hooks()` in `AgentRuntime`. Add `shell_path` to `HookManagementService`; `handle_hooks_command()` resolves normal mycli configuration and passes its value so list/approve/revoke compute the same command digest as runtime loading.

Add `shell_resolver` injection to `DoctorService`. Resolve normal mycli configuration once inside the service and pass its `shell_path` to both `_check_shell_backend_diagnostics()` and `_check_tool_environment()`; report `ShellResolutionError` as a warning. Remove their `$SHELL` and `/bin/bash` branches.

Give `LintTool` and `WriteDiagnosticsService` a stored `shell_path`. Add `configure_shell_path()` to both `BashTool` and `LintTool`; extend `AgentRuntime`'s existing tool-configuration loop to call it with `config.shell_path`. Construct `WriteDiagnosticsService(shell_path=config.shell_path)` so automatic post-write linting and the user-visible Lint tool select the same Bash.

- [ ] **Step 4: Make Python subprocess commands portable in tests**

Create:

```python
from __future__ import annotations

from pathlib import Path
import shlex
import sys


def python_shell_command(source: str) -> str:
    executable = Path(sys.executable).as_posix()
    return f"{shlex.quote(executable)} -c {shlex.quote(source)}"
```

Replace executable hard-coding such as `python3 -c ...` whenever the test actually launches a process in `test_agent_runtime.py`, `test_tool_execution_service.py`, `test_bash.py`, `test_run_shell.py`, `test_bash_output.py`, `test_shell_session_manager.py`, and `test_doctor_service.py`. Keep preview-only strings unchanged when no process is launched. Git Bash accepts the forward-slash Windows executable path and preserves Bash command semantics.

For configured-hook tests whose command is an argv list rather than a Bash string, replace `command=["python3", ...]` with `command=[sys.executable, ...]`. Do the same for any other test that passes a Python executable directly to `subprocess`; do not change fixtures that only verify redaction or rendering of the literal text `python3`.

- [ ] **Step 5: Run focused tests and scan for bypasses**

```bash
uv run pytest tests/unit/test_lint.py \
  tests/unit/services/test_configured_hooks.py \
  tests/unit/services/test_hook_management.py \
  tests/unit/services/test_doctor_service.py \
  src/mycli/services/hooks/setup.py src/mycli/services/hooks/management.py \
  src/mycli/cli/main.py src/mycli/services/write_diagnostics.py \
  src/mycli/application/runtime/agent_runtime.py \
  tests/unit/tools/test_bash_output.py \
  tests/unit/tools/test_shell_session_manager.py -q
rg -n 'shell=True|\("sh", "-c"|get\("SHELL"\)|/bin/bash' src/mycli
uv run ruff check src/mycli/services/diagnostics/doctor.py \
  src/mycli/tools/lint.py src/mycli/services/hooks/config.py \
  tests/support/shell_commands.py
```

Expected: focused tests pass. Remaining scan matches are limited to the centralized resolver, explicit legacy-data tests, or comments; no executable consumer independently selects a shell.

- [ ] **Step 6: Commit unified shell consumers**

```bash
git add src/mycli/services/diagnostics/doctor.py \
  src/mycli/tools/lint.py src/mycli/services/hooks/config.py \
  tests/support/shell_commands.py tests/unit/test_lint.py \
  tests/unit/services/test_configured_hooks.py \
  tests/unit/services/test_doctor_service.py \
  tests/unit/application/test_agent_runtime.py \
  tests/unit/application/test_tool_execution_service.py \
  tests/unit/test_bash.py tests/unit/tools/test_run_shell.py \
  tests/unit/tools/test_bash_output.py \
  tests/unit/tools/test_shell_session_manager.py
git commit -m "Use one Bash resolver across mycli"
```

## Task 7: Adapt The Node TUI Launcher, TTY, Clipboard, And Key Labels

**Files:**
- Modify: `src/mycli/cli/node_tui/process.py:112-162`
- Modify: `tests/unit/cli/node_tui/test_process.py`
- Modify: `tui/mycli-shell/src/adapters/tty-terminal.ts:1-110`
- Modify: `tui/mycli-shell/test/tty-terminal.test.ts`
- Modify: `tui/mycli-shell/src/gateway.ts:650-670`
- Modify: `tui/mycli-shell/src/setup.ts:35-60`
- Create: `tui/mycli-shell/src/adapters/clipboard.ts`
- Create: `tui/mycli-shell/test/clipboard.test.ts`
- Modify: `tui/mycli-shell/src/components/keybinding-hints.ts:1-20`
- Create: `tui/mycli-shell/test/keybinding-hints.test.ts`
- Modify: `tui/mycli-shell/src/shell-runtime.ts:1-30,1789-1796`

- [ ] **Step 1: Write failing Python launcher tests**

```python
def test_build_node_command_uses_tsx_cmd_on_windows(tmp_path: Path) -> None:
    node_root = tmp_path / "tui" / "mycli-shell"
    tsx = node_root / "node_modules" / ".bin" / "tsx.cmd"
    entrypoint = node_root / "src" / "gateway.ts"
    tsx.parent.mkdir(parents=True)
    entrypoint.parent.mkdir(parents=True)
    tsx.write_text("@node tsx", encoding="utf-8")
    entrypoint.write_text("export {}", encoding="utf-8")
    assert build_node_command(repo_root=tmp_path, env={}, platform_name="win32") == [
        str(tsx),
        str(entrypoint),
    ]
```

- [ ] **Step 2: Write failing Node TTY and clipboard tests**

Test exported dependency-injected functions, including a `registerProcessSignals(platform, processLike)` boundary that omits unsupported Windows signals:

```typescript
test("Windows uses interactive stdio instead of /dev/tty", () => {
  const streams = openTtyStreams({
    platform: "win32",
    stdin: fakeTtyInput(),
    stdout: fakeTtyOutput(),
    openSync: () => { throw new Error("must not open /dev/tty"); },
  });
  assert.equal(streams.input, stdin);
});

test("Windows clipboard uses clip.exe", () => {
  const calls: string[] = [];
  assert.equal(copyText("hello", {
    platform: "win32",
    spawnSync: (command) => { calls.push(command); return { status: 0 }; },
    which: () => undefined,
  }), true);
  assert.deepEqual(calls, ["clip.exe"]);
});

test("Linux clipboard prefers wl-copy and degrades when unavailable", () => {
    // Assert wl-copy selection, then false when wl-copy/xclip/xsel are absent.
});

test("Windows signal registration omits POSIX-only handlers", () => {
    // Assert only signals supported by Node on win32 are registered.
});
```

- [ ] **Step 3: Run tests to verify RED**

```bash
uv run pytest tests/unit/cli/node_tui/test_process.py -k windows -q
npm --prefix tui/mycli-shell test -- --test-name-pattern="Windows|clipboard"
```

Expected: Python functions lack platform injection and Node adapters do not exist.

- [ ] **Step 4: Implement launcher and adapters**

Add `platform_name: str = sys.platform` to `build_node_command()` and `build_node_setup_command()`. Resolve:

```python
tsx_name = "tsx.cmd" if platform_name == "win32" else "tsx"
tsx_bin = node_root / "node_modules" / ".bin" / tsx_name
```

In `tty-terminal.ts`, define `OpenTtyOptions` with injected `platform`, `stdin`, `stdout`, and `openSync`. On Windows, require `stdin.isTTY`, `stdout.isTTY`, and `stdin.setRawMode`; return stdio streams with a no-op `close`. On Unix, retain `/dev/tty` opening and owned-descriptor cleanup. Error messages must name the missing raw TTY capability rather than `/dev/tty` on Windows.

Move gateway/setup signal registration behind a platform-injected helper. Register only signals supported on the active platform; do not register suspend/resume handlers on Windows. Keep the current shutdown exit codes and cleanup callbacks unchanged.

Create `clipboard.ts` exporting `copyText(text, options?)`. Select:

- `pbcopy` on `darwin`;
- `clip.exe` on `win32`;
- first available of `wl-copy`, `xclip -selection clipboard`, and `xsel --clipboard --input` on Linux.

Return false on missing command, non-zero status, or spawn exception. Replace `copyTextBestEffort()` in `shell-runtime.ts` with this adapter.

Change `formatKeyText()` to accept `platform: NodeJS.Platform = process.platform`. Keep the existing macOS `alt` to `option` conversion, and add platform-injected tests proving Linux and Windows retain `alt`.

- [ ] **Step 5: Run Python and Node checks**

```bash
uv run pytest tests/unit/cli/node_tui/test_process.py -q
npm --prefix tui/mycli-shell test
npm --prefix tui/mycli-shell run typecheck
uv run ruff check src/mycli/cli/node_tui/process.py tests/unit/cli/node_tui/test_process.py
uv run mypy src/mycli/cli/node_tui/process.py
```

Expected: launcher, TTY, clipboard, all existing Node tests, typecheck, and Python static checks pass.

- [ ] **Step 6: Commit Node platform support**

```bash
git add src/mycli/cli/node_tui/process.py \
  tests/unit/cli/node_tui/test_process.py \
  tui/mycli-shell/src/adapters/tty-terminal.ts \
  tui/mycli-shell/src/adapters/clipboard.ts \
  tui/mycli-shell/src/gateway.ts tui/mycli-shell/src/setup.ts \
  tui/mycli-shell/src/components/keybinding-hints.ts \
  tui/mycli-shell/src/shell-runtime.ts \
  tui/mycli-shell/test/tty-terminal.test.ts \
  tui/mycli-shell/test/clipboard.test.ts \
  tui/mycli-shell/test/keybinding-hints.test.ts
git commit -m "Adapt the Node TUI across platforms"
```

## Task 8: Add Three-Platform CI And Source-Checkout Documentation

**Files:**
- Create: `.github/workflows/cross-platform.yml`
- Create: `tests/integration/test_cross_platform_shell.py`
- Modify: `README.md`
- Create: `docs/windows.md`
- Modify: `docs/superpowers/specs/README.md`

- [ ] **Step 1: Add the CI workflow**

Create:

```yaml
name: cross-platform

on:
  push:
  pull_request:

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v6
        with:
          python-version: "3.13"
      - uses: actions/setup-node@v4
        with:
          node-version: "22.19.0"
          cache: npm
          cache-dependency-path: tui/mycli-shell/package-lock.json
      - run: uv sync --locked --dev
      - run: npm ci --prefix tui/mycli-shell
      - run: uv run pytest -q
      - run: uv run ruff check .
      - run: uv run mypy src/mycli
      - run: npm --prefix tui/mycli-shell test
      - run: npm --prefix tui/mycli-shell run typecheck
      - name: Shell lifecycle smoke
        run: uv run pytest tests/integration/test_cross_platform_shell.py -q
```

Create `tests/integration/test_cross_platform_shell.py` with six explicit tests using the public APIs:

```python
def _wait_for_terminal(shell_id: str, *, timeout_seconds: float = 5.0) -> ToolResult:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        result = BashOutputTool().execute({"shell_id": shell_id})
        if result.raw_payload.get("status") != "running":
            return result
        time.sleep(0.02)
    raise AssertionError(f"shell {shell_id} did not finish")
```

Cover foreground `printf cross-platform`, non-zero `exit 7`, background `printf start; sleep 0.2; printf end` with bounded `BashOutputTool` polling, `sleep 2` with timeout 1, foreground interruption using `RuntimeInterruptToken`, and background termination using `KillShellTool`. The bounded helper avoids long fixed sleeps while preserving Bash semantics on all three platforms.

- [ ] **Step 2: Document platform setup**

Update `README.md` with:

- Python 3.13, uv, Node 22.19+, npm;
- `uv sync --dev` and `npm ci --prefix tui/mycli-shell`;
- Linux/macOS launch command;
- PowerShell launch command `uv run mycli`;
- explicit statement that Windows agent commands use Git Bash.

Create `docs/windows.md` with:

```toml
shell_path = "C:\\Program Files\\Git\\bin\\bash.exe"
```

and environment override examples for PowerShell:

```powershell
$env:MYCLI_SHELL_PATH = "C:\Program Files\Git\bin\bash.exe"
uv run mycli
```

Include the resolver search order, Git for Windows prerequisite, PATH troubleshooting, and the statement that WSL/PowerShell command syntax is outside the first-release shell contract.

Add links for `2026-07-13-cross-platform-runtime-design.md` and `../plans/2026-07-13-cross-platform-runtime-implementation.md` to `docs/superpowers/specs/README.md` using the index's existing format.

- [ ] **Step 3: Validate workflow and documentation references**

```bash
uv run pytest tests/integration/test_cross_platform_shell.py -q
rg -n "Python 3.13|Node 22.19|Git Bash|MYCLI_SHELL_PATH|shell_path" README.md docs/windows.md
git diff --check
```

Expected: smoke tests pass, all required setup terms are present, and no whitespace errors exist.

- [ ] **Step 4: Commit CI and documentation**

```bash
git add .github/workflows/cross-platform.yml \
  tests/integration/test_cross_platform_shell.py README.md docs/windows.md \
  docs/superpowers/specs/README.md
git commit -m "Verify mycli on Linux macOS and Windows"
```

## Task 9: Run Final Cross-Platform Regression Verification

**Files:**
- Modify only files required to fix failures found by the commands below.

- [ ] **Step 1: Run all Python tests**

```bash
uv run pytest -q
```

Expected: zero failures.

- [ ] **Step 2: Run Python lint and type checks**

```bash
uv run ruff check .
uv run mypy src/mycli
```

Expected: Ruff reports no errors and Mypy succeeds.

- [ ] **Step 3: Run all Node checks**

```bash
npm --prefix tui/mycli-shell test
npm --prefix tui/mycli-shell run typecheck
```

Expected: all Node tests and TypeScript typechecking pass.

- [ ] **Step 4: Run local shell lifecycle smoke tests**

```bash
uv run pytest tests/integration/test_cross_platform_shell.py -q
uv run mycli --plain --help
```

Expected: integration smoke tests pass and the CLI help exits with code 0.

- [ ] **Step 5: Inspect platform assumptions**

```bash
rg -n "shell=True|os\.killpg|SIGKILL|/dev/tty|node_modules/.bin/tsx" \
  src/mycli tui/mycli-shell/src
```

Expected: remaining matches are inside centralized platform adapters, guarded Unix branches, tests, or documentation. No business-layer shell execution uses `shell=True` or `$SHELL`.

- [ ] **Step 6: Handle verification failures at their owning task boundary**

If a command fails, return to the task that owns the affected file, add a failing regression test there, implement the minimal fix, rerun that task's focused checks, and commit with that task's explicit file list. Do not create a generic catch-all verification commit or an empty commit.
