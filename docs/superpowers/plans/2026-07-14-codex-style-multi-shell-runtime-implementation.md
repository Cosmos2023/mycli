# Codex-Style Multi-Shell Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mycli's Bash-only runtime contract with one model-visible `Shell` tool backed by typed POSIX, PowerShell, and CMD profiles while preserving legacy Bash sessions and the existing foreground/background lifecycle.

**Architecture:** Introduce `ShellProfile` in the runtime domain and resolve it once from the configured path and host platform. Route command argv, prompt guidance, safety analysis, approvals, hooks, diagnostics, persistence, and TUI projection through that profile. Keep the existing shell session manager and process controller as the lifecycle engine; add hidden `Bash`/`BashOutput` compatibility executors while exposing only `Shell`/`ShellOutput` to new model requests.

**Tech Stack:** Python 3.13, `subprocess`, `pwd` on Unix, pytest, Ruff, Mypy, Node.js 22.19+, TypeScript 5.9, Node test runner, GitHub Actions.

---

## File Map

- Create `src/mycli/domain/runtime/shell_profile.py`: shell kinds, PowerShell editions, immutable profile, display name, and argv derivation.
- Modify `src/mycli/domain/runtime/__init__.py`: export profile types and add shell kind to session allowances.
- Rewrite `src/mycli/tools/shell_resolver.py`: Codex-style explicit-path recognition, platform detection, ignored-override diagnostics, and ultimate fallbacks.
- Modify `tests/unit/tools/test_shell_resolver.py`: injected Windows/macOS/Linux detection and fallback coverage.
- Create `src/mycli/tools/shell_safety_adapters.py`: POSIX, PowerShell, and CMD safety dispatch with conservative parse-failure behavior.
- Modify `src/mycli/tools/shell_safety.py`: retain existing POSIX behavior behind the adapter boundary.
- Modify `src/mycli/services/approval/safety_policy.py`: evaluate `Shell`/legacy aliases through the active profile.
- Modify `tests/unit/services/test_safety_policy.py`: shell-aware risk decisions and conservative Windows coverage.
- Modify `src/mycli/domain/runtime/execution_policy.py`: carry `ShellProfile` through execution options without exposing executable paths in trace payloads.
- Modify `src/mycli/application/runtime/tools/runtime_policy.py`: resolve and forward the active profile.
- Modify `src/mycli/tools/shell_backend.py`: carry the profile in backend requests.
- Modify `src/mycli/tools/shell_registry.py`: pass the profile into session starts.
- Modify `src/mycli/tools/shell_session_manager.py`: derive explicit argv from the profile and add shell metadata to lifecycle payloads.
- Modify `src/mycli/tools/bash.py`: extract shared implementation and provide `ShellTool` plus hidden `BashTool` compatibility.
- Create `src/mycli/tools/shell_output.py`: model-visible `ShellOutputTool` with the current polling contract.
- Modify `src/mycli/tools/bash_output.py`: retain `BashOutputTool` as a compatibility executor.
- Modify `src/mycli/tools/registry.py`: register visible Shell tools and hidden compatibility aliases.
- Modify `src/mycli/tools/routing/tool_exposure_planner.py`: expose only `Shell` and `ShellOutput`.
- Modify `src/mycli/services/hooks/builtin/permission_guard.py`: treat Shell and legacy Bash as high risk.
- Modify `tests/unit/tools/test_registry.py`, `tests/unit/cli/test_main.py`, and routing tests: assert schema visibility and alias execution.
- Create `src/mycli/prompts/shell.py`: compact profile-specific model guidance.
- Modify `src/mycli/prompts/templates/system.md`: replace Bash-only wording with stable Shell wording.
- Modify `src/mycli/application/runtime/agent_runtime.py`: resolve one profile and inject dynamic guidance outside the session instruction snapshot.
- Modify request-shape tests: assert cache-stable base prompt and dynamic shell context.
- Modify `src/mycli/services/approval/approval_service.py`: scope allowances by shell kind.
- Modify `src/mycli/application/turn_service.py`, `src/mycli/application/runtime/turn_executor.py`, and `src/mycli/application/runtime/agent_runtime.py`: persist shell kind when granting session allowance.
- Modify session-store serialization tests: old allowances default to Bash; new allowances round-trip shell kind.
- Modify `src/mycli/services/hooks/config.py`: preserve whether a hook is direct argv or active-shell string and attach shell kind.
- Modify `src/mycli/services/hooks/allowlist.py`: include shell kind in string-hook digest identity.
- Modify `src/mycli/tools/lint.py` and `src/mycli/services/write_diagnostics.py`: prefer argv execution and use the profile only for configured compound strings.
- Modify `src/mycli/services/diagnostics/doctor.py`: report active profile and ignored override.
- Modify hook, lint, and doctor tests.
- Modify shell lifecycle domain/event payloads and session projections to retain shell kind and edition.
- Modify `tui/mycli-shell/src/adapters/runtime-state.ts`, `components/tool-display.ts`, and `components/tool-presentation.ts`: render new Shell labels and profile details while preserving legacy Bash history.
- Modify Node TUI tests for new and legacy records.
- Modify `.github/workflows/cross-platform.yml`: force PowerShell Core, Desktop, and CMD integration lanes on Windows.
- Replace `tests/integration/test_cross_platform_shell.py` with profile-parameterized lifecycle smoke coverage.
- Modify `README.md` and `docs/windows.md`: Git Bash becomes optional and Windows fallback behavior is documented.

## Task 1: Add The Shell Profile Domain Model

**Files:**
- Create: `src/mycli/domain/runtime/shell_profile.py`
- Modify: `src/mycli/domain/runtime/__init__.py`
- Create: `tests/unit/domain/runtime/test_shell_profile.py`

- [ ] **Step 1: Write failing profile tests**

```python
from pathlib import Path

import pytest

from mycli.domain.runtime import PowerShellEdition, ShellKind, ShellProfile


@pytest.mark.parametrize(
    ("profile", "command", "expected"),
    [
        (ShellProfile(ShellKind.BASH, Path("/bin/bash")), "printf ok", ["/bin/bash", "-c", "printf ok"]),
        (ShellProfile(ShellKind.ZSH, Path("/bin/zsh")), "printf ok", ["/bin/zsh", "-c", "printf ok"]),
        (ShellProfile(ShellKind.SH, Path("/bin/sh")), "printf ok", ["/bin/sh", "-c", "printf ok"]),
        (
            ShellProfile(
                ShellKind.POWERSHELL,
                Path(r"C:\Program Files\PowerShell\7\pwsh.exe"),
                PowerShellEdition.CORE,
            ),
            "Get-Location",
            [
                r"C:\Program Files\PowerShell\7\pwsh.exe",
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-Location",
            ],
        ),
        (
            ShellProfile(ShellKind.CMD, Path("cmd.exe")),
            "dir /a",
            ["cmd.exe", "/d", "/s", "/c", "dir /a"],
        ),
    ],
)
def test_shell_profile_derives_exec_argv(profile, command, expected) -> None:
    assert profile.exec_argv(command) == expected


def test_powershell_requires_edition() -> None:
    with pytest.raises(ValueError, match="edition"):
        ShellProfile(ShellKind.POWERSHELL, Path("pwsh.exe"))


def test_non_powershell_rejects_edition() -> None:
    with pytest.raises(ValueError, match="only valid"):
        ShellProfile(ShellKind.BASH, Path("/bin/bash"), PowerShellEdition.CORE)
```

- [ ] **Step 2: Run the tests to verify RED**

```bash
uv run pytest tests/unit/domain/runtime/test_shell_profile.py -q
```

Expected: collection fails because the profile types do not exist.

- [ ] **Step 3: Implement the profile types**

```python
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path


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

    def __post_init__(self) -> None:
        if self.kind is ShellKind.POWERSHELL and self.powershell_edition is None:
            raise ValueError("PowerShell profile requires an edition.")
        if self.kind is not ShellKind.POWERSHELL and self.powershell_edition is not None:
            raise ValueError("PowerShell edition is only valid for PowerShell profiles.")

    def exec_argv(self, command: str) -> list[str]:
        executable = str(self.executable)
        if self.kind in {ShellKind.ZSH, ShellKind.BASH, ShellKind.SH}:
            return [executable, "-c", command]
        if self.kind is ShellKind.POWERSHELL:
            return [
                executable,
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                command,
            ]
        return [executable, "/d", "/s", "/c", command]

    @property
    def display_name(self) -> str:
        if self.kind is ShellKind.POWERSHELL:
            return "PowerShell 7" if self.powershell_edition is PowerShellEdition.CORE else "Windows PowerShell 5.1"
        return self.kind.value
```

Export all three types from `mycli.domain.runtime`.

- [ ] **Step 4: Run tests and static checks**

```bash
uv run pytest tests/unit/domain/runtime/test_shell_profile.py -q
uv run ruff check src/mycli/domain/runtime/shell_profile.py tests/unit/domain/runtime/test_shell_profile.py
uv run mypy src/mycli/domain/runtime/shell_profile.py
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/mycli/domain/runtime/shell_profile.py src/mycli/domain/runtime/__init__.py tests/unit/domain/runtime/test_shell_profile.py
git commit -m "Add typed shell profiles"
```

## Task 2: Implement Codex-Style Shell Detection

**Files:**
- Modify: `src/mycli/tools/shell_resolver.py`
- Modify: `tests/unit/tools/test_shell_resolver.py`

- [ ] **Step 1: Replace resolver tests with profile-based expectations**

Add injected tests covering:

```python
def test_windows_prefers_pwsh_over_desktop_and_cmd() -> None:
    profile = detect_shell_profile(
        None,
        platform_name="win32",
        env={"PATH": "ignored"},
        path_exists=lambda _path: False,
        which=lambda name, _path: r"C:\Tools\pwsh.exe" if name == "pwsh" else None,
    )
    assert profile.kind is ShellKind.POWERSHELL
    assert profile.powershell_edition is PowerShellEdition.CORE


def test_windows_falls_back_to_desktop_then_cmd() -> None:
    desktop = detect_shell_profile(
        None,
        platform_name="win32",
        env={},
        path_exists=lambda path: str(path).endswith("powershell.exe"),
        which=lambda _name, _path: None,
    )
    assert desktop.kind is ShellKind.POWERSHELL
    assert desktop.powershell_edition is PowerShellEdition.DESKTOP


def test_windows_ultimate_fallback_is_cmd() -> None:
    profile = detect_shell_profile(
        None,
        platform_name="win32",
        env={},
        path_exists=lambda _path: False,
        which=lambda _name, _path: None,
    )
    assert profile == ShellProfile(ShellKind.CMD, Path("cmd.exe"))


def test_invalid_explicit_path_is_ignored() -> None:
    profile = detect_shell_profile(
        r"D:\missing\pwsh.exe",
        platform_name="win32",
        env={},
        path_exists=lambda _path: False,
        which=lambda name, _path: "cmd.exe" if name in {"cmd", "cmd.exe"} else None,
    )
    assert profile.kind is ShellKind.CMD


def test_unknown_explicit_executable_is_ignored() -> None:
    profile = detect_shell_profile(
        r"D:\tools\company-shell.exe",
        platform_name="win32",
        env={},
        path_exists=lambda path: "company-shell" in str(path),
        which=lambda name, _path: "cmd.exe" if name in {"cmd", "cmd.exe"} else None,
    )
    assert profile.kind is ShellKind.CMD


def test_macos_prefers_user_zsh() -> None:
    profile = detect_shell_profile(
        None,
        platform_name="darwin",
        env={},
        user_shell=lambda: Path("/bin/zsh"),
        path_exists=lambda path: path == Path("/bin/zsh"),
        which=lambda _name, _path: None,
    )
    assert profile.kind is ShellKind.ZSH


def test_linux_prefers_user_shell_then_bash() -> None:
    profile = detect_shell_profile(
        None,
        platform_name="linux",
        env={},
        user_shell=lambda: Path("/unsupported/fish"),
        path_exists=lambda path: path == Path("/bin/bash"),
        which=lambda _name, _path: None,
    )
    assert profile.kind is ShellKind.BASH
```

Also add `resolve_shell_diagnostics()` tests proving an ignored explicit override is reported without changing the returned profile.

- [ ] **Step 2: Run resolver tests to verify RED**

```bash
uv run pytest tests/unit/tools/test_shell_resolver.py -q
```

Expected: failures because the resolver still returns `ShellCommandConfig` and raises on invalid explicit paths.

- [ ] **Step 3: Implement detection and diagnostics**

Use these public shapes:

```python
@dataclass(frozen=True, slots=True)
class ShellResolution:
    profile: ShellProfile
    explicit_path_status: Literal["not_configured", "accepted", "ignored"]
    explicit_path_reason: str | None = None


def detect_shell_profile(custom_shell_path: str | None, **injected) -> ShellProfile:
    return detect_shell_profile_with_diagnostics(custom_shell_path, **injected).profile
```

Recognition removes a case-insensitive `.exe` suffix and accepts only `zsh`, `bash`, `sh`, `pwsh`, `powershell`, and `cmd`. Implement Windows, macOS, and Linux order exactly as specified in the design. Use an injected `user_shell: Callable[[], Path | None]`; production Unix implementation reads `pwd.getpwuid(os.getuid()).pw_shell`, catches lookup errors, and returns `None`. Ultimate fallbacks are `cmd.exe` and `/bin/sh` even when existence checks fail.

- [ ] **Step 4: Keep the existing Bash resolver active until the safety boundary is ready**

Retain the current `resolve_shell()` and `ShellCommandConfig` compatibility API unchanged in this task. Production consumers continue using it, so native Windows still requires Bash in this intermediate commit. The new `detect_shell_profile()` API is used only by its unit tests until Task 4 switches detection, safety, and execution together.

- [ ] **Step 5: Run focused and static checks**

```bash
uv run pytest tests/unit/tools/test_shell_resolver.py tests/unit/tools/test_shell_session_manager.py -q
uv run ruff check src/mycli/tools/shell_resolver.py tests/unit/tools/test_shell_resolver.py
uv run mypy src/mycli/tools/shell_resolver.py
```

- [ ] **Step 6: Commit**

```bash
git add src/mycli/tools/shell_resolver.py tests/unit/tools/test_shell_resolver.py
git commit -m "Detect native shells across platforms"
```

## Task 3: Add The Conservative Shell Safety Boundary

**Files:**
- Create: `src/mycli/tools/shell_safety_adapters.py`
- Modify: `src/mycli/tools/shell_safety.py`
- Modify: `src/mycli/services/approval/safety_policy.py`
- Create: `tests/unit/tools/test_shell_safety_adapters.py`
- Modify: `tests/unit/services/test_safety_policy.py`

- [ ] **Step 1: Write failing adapter tests**

```python
@pytest.mark.parametrize("kind", [ShellKind.POWERSHELL, ShellKind.CMD])
def test_unknown_windows_construct_requires_confirmation(kind: ShellKind) -> None:
    profile = profile_for(kind)
    analysis = analyze_shell_for_profile(profile, "opaque $(dynamic) expression")
    assert analysis.risk_level is ShellRiskLevel.CONFIRM
    assert analysis.command_pattern is None


def test_powershell_read_only_commands_are_allowed() -> None:
    profile = powershell_core_profile()
    analysis = analyze_shell_for_profile(profile, "Get-Location")
    assert analysis.risk_level is ShellRiskLevel.ALLOW
    assert analysis.command_pattern == "Get-Location"


@pytest.mark.parametrize(
    "command",
    [
        "Remove-Item -Recurse -Force .\\build",
        "Stop-Process -Name python -Force",
        "git reset --hard HEAD~1",
    ],
)
def test_powershell_destructive_commands_require_confirmation(command: str) -> None:
    analysis = analyze_shell_for_profile(powershell_core_profile(), command)
    assert analysis.risk_level in {ShellRiskLevel.CONFIRM, ShellRiskLevel.DENY}


def test_cmd_read_only_dir_is_allowed() -> None:
    analysis = analyze_shell_for_profile(cmd_profile(), "dir /a")
    assert analysis.risk_level is ShellRiskLevel.ALLOW


@pytest.mark.parametrize("command", ["del /s /q build", "taskkill /f /im python.exe", "git clean -fdx"])
def test_cmd_destructive_commands_require_confirmation(command: str) -> None:
    analysis = analyze_shell_for_profile(cmd_profile(), command)
    assert analysis.risk_level in {ShellRiskLevel.CONFIRM, ShellRiskLevel.DENY}
```

Add SafetyPolicy tests proving `Shell`, `Bash`, and `run_shell` canonicalize to the same high-risk category but the active profile selects the adapter.

- [ ] **Step 2: Run tests to verify RED**

```bash
uv run pytest tests/unit/tools/test_shell_safety_adapters.py tests/unit/services/test_safety_policy.py -q
```

- [ ] **Step 3: Implement the safety dispatcher before enabling new shells**

Define:

```python
class ShellSafetyAdapter(Protocol):
    def analyze(self, command: str) -> ShellSafetyAnalysis: ...


def analyze_shell_for_profile(profile: ShellProfile, command: str) -> ShellSafetyAnalysis:
    if profile.kind in {ShellKind.ZSH, ShellKind.BASH, ShellKind.SH}:
        return PosixShellSafetyAdapter().analyze(command)
    if profile.kind is ShellKind.POWERSHELL:
        return PowerShellSafetyAdapter().analyze(command)
    return CmdSafetyAdapter().analyze(command)
```

`PosixShellSafetyAdapter` calls the existing `analyze_shell_command()` unchanged.

For PowerShell and CMD, implement a quote-aware top-level splitter in this file rather than using `shlex`. It must track single/double quotes and reject unbalanced quotes. PowerShell additionally tracks brace/parenthesis depth; CMD recognizes `&`, `&&`, `||`, `|`, `>`, and `<`. Only auto-allow a small exact read-only set:

```text
PowerShell: Get-Location, Get-Date, Get-ChildItem, Test-Path, git status, git diff, git log, git show
CMD: cd, dir, echo, type, where, git status, git diff, git log, git show
```

Recognize destructive heads and return the current confirmation/deny policy. Any variable expansion, script block, invocation operator, redirection, unsupported command head, or parse error returns `CONFIRM` with no reusable command pattern. This is intentionally conservative.

- [ ] **Step 4: Make SafetyPolicy profile-aware without changing production defaults yet**

Add `shell_profile: ShellProfile | None = None` to `SafetyPolicy.__init__`. `None` preserves the existing POSIX analysis for callers not migrated until Task 4; production `AgentRuntime` must always supply a resolved profile once Task 4 lands. Canonicalize `Shell`, `Bash`, and `run_shell` to `Shell`; canonicalize `ShellOutput` and `BashOutput` to `ShellOutput`. Shell evaluation calls `analyze_shell_for_profile(profile, command)` when a profile is present and includes `shell_kind` and `shell_edition` in safety metadata.

- [ ] **Step 5: Run focused tests and existing POSIX regression tests**

```bash
uv run pytest tests/unit/tools/test_shell_safety_adapters.py tests/unit/test_shell_safety.py tests/unit/services/test_safety_policy.py -q
uv run ruff check src/mycli/tools/shell_safety_adapters.py src/mycli/services/approval/safety_policy.py
uv run mypy src/mycli/tools/shell_safety_adapters.py src/mycli/services/approval/safety_policy.py
```

- [ ] **Step 6: Commit**

```bash
git add src/mycli/tools/shell_safety_adapters.py src/mycli/tools/shell_safety.py src/mycli/services/approval/safety_policy.py tests/unit/tools/test_shell_safety_adapters.py tests/unit/services/test_safety_policy.py
git commit -m "Analyze commands by shell type"
```

## Task 4: Thread Shell Profiles Through Execution

**Files:**
- Modify: `src/mycli/domain/runtime/execution_policy.py`
- Modify: `src/mycli/application/runtime/tools/runtime_policy.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/tools/shell_backend.py`
- Modify: `src/mycli/tools/shell_registry.py`
- Modify: `src/mycli/tools/shell_session_manager.py`
- Modify: `src/mycli/tools/bash.py`
- Modify: `tests/unit/application/test_tool_policy_runtime.py`
- Modify: `tests/unit/tools/test_shell_session_manager.py`
- Modify: `tests/unit/tools/test_run_shell.py`
- Modify: `tests/unit/tools/test_bash_output.py`
- Modify: `tests/unit/test_kill_shell.py`

- [ ] **Step 1: Write failing execution tests**

Add manager tests asserting exact argv for Bash, PowerShell Core, Desktop, and CMD. Add runtime-policy tests asserting the profile reaches `ShellBackendRequest`. Add payload tests asserting:

```python
assert result["shell_kind"] == "powershell"
assert result["shell_edition"] == "core"
assert "shell_path" not in result
```

Retain timeout, interrupt, BashOutput polling, and KillShell assertions for each injected profile without duplicating real long-running processes.

- [ ] **Step 2: Run tests to verify RED**

```bash
uv run pytest tests/unit/application/test_tool_policy_runtime.py tests/unit/tools/test_shell_session_manager.py tests/unit/tools/test_run_shell.py tests/unit/tools/test_bash_output.py tests/unit/test_kill_shell.py -q
```

- [ ] **Step 3: Carry the profile through typed requests**

Add `shell_profile: ShellProfile` to `ShellExecutionOptions` and `ShellBackendRequest`. Keep `shell_path` only at configuration/resolution boundaries. `ShellExecutionOptions.to_trace_payload()` returns booleans and stable metadata:

```python
{
    "shell_kind": self.shell_profile.kind.value,
    "shell_edition": (
        self.shell_profile.powershell_edition.value
        if self.shell_profile.powershell_edition is not None
        else None
    ),
    "custom_shell_path": self.shell_path is not None,
}
```

Do not serialize the executable path.

- [ ] **Step 4: Resolve once in AgentRuntime and configure all shell consumers**

Resolve `self._shell_resolution = detect_shell_profile_with_diagnostics(config.shell_path)` during runtime construction. Pass `.profile` into `RuntimePolicyGate`, `SafetyPolicy`, Bash/Shell tools, hook registration, diagnostics, and write diagnostics. Direct `execute_bash()` callers may omit a profile; they resolve one from `shell_path` at the public boundary. After all consumers compile against profiles, remove the legacy `ShellCommandConfig` and make `resolve_shell()` a deprecated alias of `detect_shell_profile()` for external callers.

- [ ] **Step 5: Spawn profile-derived argv**

Replace session-manager construction of `[executable, "-c", command]` with `request.shell_profile.exec_argv(command)`. Add stable `shell_kind` and optional `shell_edition` to start, poll, terminal, timeout, interrupt, and kill payloads.

- [ ] **Step 6: Run lifecycle tests and static checks**

```bash
uv run pytest tests/unit/application/test_tool_policy_runtime.py tests/unit/tools/test_shell_session_manager.py tests/unit/tools/test_run_shell.py tests/unit/tools/test_bash_output.py tests/unit/test_kill_shell.py -q
uv run ruff check src/mycli/domain/runtime/execution_policy.py src/mycli/tools/shell_backend.py src/mycli/tools/shell_session_manager.py
uv run mypy src/mycli/domain/runtime/execution_policy.py src/mycli/tools/shell_backend.py src/mycli/tools/shell_session_manager.py
```

- [ ] **Step 7: Commit**

```bash
git add src/mycli/domain/runtime/execution_policy.py src/mycli/application/runtime/tools/runtime_policy.py src/mycli/application/runtime/agent_runtime.py src/mycli/tools/shell_backend.py src/mycli/tools/shell_registry.py src/mycli/tools/shell_session_manager.py src/mycli/tools/bash.py tests/unit/application/test_tool_policy_runtime.py tests/unit/tools/test_shell_session_manager.py tests/unit/tools/test_run_shell.py tests/unit/tools/test_bash_output.py tests/unit/test_kill_shell.py
git commit -m "Execute commands through shell profiles"
```

## Task 5: Introduce The Unified Shell Tool Contract

**Files:**
- Modify: `src/mycli/tools/bash.py`
- Create: `src/mycli/tools/shell_output.py`
- Modify: `src/mycli/tools/bash_output.py`
- Modify: `src/mycli/tools/registry.py`
- Modify: `src/mycli/tools/routing/tool_exposure_planner.py`
- Modify: `src/mycli/services/hooks/builtin/permission_guard.py`
- Modify: `tests/unit/tools/test_tool_registry.py`
- Modify: `tests/unit/services/test_tool_exposure_planner.py`
- Modify: `tests/unit/cli/test_main.py`
- Modify: `tests/unit/infrastructure/test_openai_client.py`
- Modify: `tests/unit/infrastructure/test_anthropic_messages_client.py`

- [ ] **Step 1: Write failing visibility and alias tests**

```python
def test_default_model_tools_expose_shell_not_bash(tmp_path: Path) -> None:
    registry = ToolRegistry.from_tools(default_tools(tmp_path))
    exposure = ToolExposurePlanner(registry).plan()
    names = {entry.name for entry in exposure.exposure.entries}
    assert "Shell" in names
    assert "ShellOutput" in names
    assert "Bash" not in names
    assert "BashOutput" not in names


def test_legacy_bash_alias_still_executes(tmp_path: Path) -> None:
    registry = ToolRegistry.from_tools(default_tools(tmp_path))
    result = registry.execute(ToolCall(name="Bash", arguments={"command": "printf ok"}))
    assert result.success is True
```

Add provider request-shape tests proving only one shell command schema is sent.

- [ ] **Step 2: Run tests to verify RED**

```bash
uv run pytest tests/unit/tools/test_tool_registry.py tests/unit/services/test_tool_exposure_planner.py tests/unit/cli/test_main.py -q
```

- [ ] **Step 3: Add visible and compatibility executors**

Extract the shared behavior in `bash.py` into `_ShellToolBase`. Define:

```python
class ShellTool(_ShellToolBase):
    name = "Shell"
    spec = ToolSpec(
        name="Shell",
        description=(
            "Execute a command in the active user shell when dedicated tools "
            "cannot handle the task. Supports timeout and background execution."
        ),
        parameters=BashTool.spec.parameters,
        risk_level="high",
    )


class BashTool(_ShellToolBase):
    name = "Bash"
    spec = replace(ShellTool.spec, name="Bash")
```

Create `ShellOutputTool` with the current BashOutput implementation. Keep `BashOutputTool` as a subclass with name/spec override. Register both visible and compatibility executors, but list only `Shell` and `ShellOutput` in `MODEL_VISIBLE_BUILTIN_TOOLS`; classify legacy aliases as hidden compatibility builtins.

- [ ] **Step 4: Update canonical tool-name boundaries**

Safety, approval, permission guard, lifecycle routing, provider replay, and tool-result normalization must canonicalize `Bash` and `run_shell` to `Shell`, and `BashOutput` to `ShellOutput`. Do not rewrite stored historical tool names.

- [ ] **Step 5: Run compatibility and provider tests**

```bash
uv run pytest tests/unit/tools/test_tool_registry.py tests/unit/services/test_tool_exposure_planner.py tests/unit/cli/test_main.py tests/unit/infrastructure/test_openai_client.py tests/unit/infrastructure/test_anthropic_messages_client.py -q
uv run ruff check src/mycli/tools/bash.py src/mycli/tools/shell_output.py src/mycli/tools/bash_output.py src/mycli/tools/registry.py
```

- [ ] **Step 6: Commit**

```bash
git add src/mycli/tools/bash.py src/mycli/tools/shell_output.py src/mycli/tools/bash_output.py src/mycli/tools/registry.py src/mycli/tools/routing/tool_exposure_planner.py src/mycli/services/hooks/builtin/permission_guard.py tests/unit/tools/test_tool_registry.py tests/unit/services/test_tool_exposure_planner.py tests/unit/cli/test_main.py tests/unit/infrastructure/test_openai_client.py tests/unit/infrastructure/test_anthropic_messages_client.py
git commit -m "Expose one cross-platform Shell tool"
```

## Task 6: Add Dynamic Shell Prompt Guidance

**Files:**
- Create: `src/mycli/prompts/shell.py`
- Modify: `src/mycli/prompts/templates/system.md`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: `src/mycli/application/runtime/context/runtime_context_builder.py`
- Modify: `tests/unit/prompts/test_prompts.py`
- Modify: `tests/unit/services/test_request_shape_builder.py`
- Modify: `tests/unit/application/test_agent_runtime.py`

- [ ] **Step 1: Write failing prompt tests**

```python
def test_powershell_desktop_guidance_avoids_core_chaining() -> None:
    text = render_shell_guidance(powershell_desktop_profile())
    assert "Windows PowerShell 5.1" in text
    assert "Do not use && or ||" in text
    assert "$env:NAME" in text


def test_cmd_guidance_uses_percent_environment_variables() -> None:
    text = render_shell_guidance(cmd_profile())
    assert "Command Prompt" in text
    assert "%NAME%" in text


def test_base_system_prompt_is_shell_agnostic() -> None:
    prompt = build_system_prompt()
    assert "Use `Shell`" in prompt
    assert "through `Bash`" not in prompt


def test_shell_guidance_is_dynamic_not_stored_in_instruction_snapshot(runtime) -> None:
    base = runtime._instruction_snapshot_system_prompt()
    context, turn_context = runtime._assemble_turn_context(
        user_message="inspect the repository",
        conversation=Conversation(),
        plan_state=PlanState(),
    )
    contract = runtime._request_pipeline.assemble_instruction_contract(
        turn_id="turn-shell-guidance",
        context=context,
        turn_context=turn_context,
        base_instructions=base,
    )
    assert "Current shell:" not in contract.base_instructions
    assert any(
        "Current shell:" in section.content
        for section in contract.memory_excluded_contextual_sections()
    )
```

- [ ] **Step 2: Run prompt tests to verify RED**

```bash
uv run pytest tests/unit/prompts/test_prompts.py tests/unit/services/test_request_shape_builder.py tests/unit/application/test_agent_runtime.py -q
```

- [ ] **Step 3: Implement compact guidance rendering**

`render_shell_guidance(profile)` returns at most six short lines. Include edition-specific PowerShell chaining guidance, CMD environment-variable syntax, and POSIX shell identity. Do not include the executable path.

- [ ] **Step 4: Keep guidance outside the cached instruction snapshot**

Replace Bash-only lines in `system.md` with stable Shell wording. In `AgentRuntime._assemble_turn_context`, prepend one deterministic shell guidance item to `runtime_reminders` before the context builder runs. The session instruction snapshot remains the unchanged base template plus its version/hash.

- [ ] **Step 5: Run prompt and cache-shape tests**

```bash
uv run pytest tests/unit/prompts tests/unit/services/test_request_shape_builder.py tests/unit/application/test_agent_runtime.py -q
uv run ruff check src/mycli/prompts/shell.py src/mycli/application/runtime/agent_runtime.py
uv run mypy src/mycli/prompts/shell.py src/mycli/application/runtime/agent_runtime.py
```

- [ ] **Step 6: Commit**

```bash
git add src/mycli/prompts/shell.py src/mycli/prompts/templates/system.md src/mycli/application/runtime/agent_runtime.py src/mycli/application/runtime/context/runtime_context_builder.py tests/unit/prompts/test_prompts.py tests/unit/services/test_request_shape_builder.py tests/unit/application/test_agent_runtime.py
git commit -m "Guide the model for the active shell"
```

## Task 7: Scope Approvals By Shell Kind

**Files:**
- Modify: `src/mycli/domain/runtime/__init__.py`
- Modify: `src/mycli/services/approval/approval_service.py`
- Modify: `src/mycli/application/turn_service.py`
- Modify: `src/mycli/application/runtime/turn_executor.py`
- Modify: `src/mycli/application/runtime/agent_runtime.py`
- Modify: session serialization and approval tests

- [ ] **Step 1: Write failing allowance tests**

```python
def test_session_allowance_matches_only_same_shell_kind() -> None:
    service = ApprovalService(
        safety_policy=SafetyPolicy(shell_profile=powershell_core_profile()),
        session_allowances=(
            SessionCommandAllowance(command_pattern="git status", shell_kind=ShellKind.BASH),
        ),
    )
    outcome = service.evaluate(ToolCall(name="Shell", arguments={"command": "git status"}))
    assert outcome.auto_approved_by != "session_allowance"


def test_legacy_allowance_defaults_to_bash() -> None:
    allowance = SessionCommandAllowance(command_pattern="git status")
    assert allowance.shell_kind is ShellKind.BASH
```

Add persistence tests for old JSON/SQLite payloads without `shell_kind` and new round trips with it.

- [ ] **Step 2: Run tests to verify RED**

```bash
uv run pytest tests/unit/services/test_approval_service.py tests/unit/services/test_session_service.py tests/unit/infrastructure/test_sqlite_session_store.py -q
```

- [ ] **Step 3: Add shell kind to allowance identity**

```python
@dataclass(slots=True, frozen=True)
class SessionCommandAllowance:
    command_pattern: str
    shell_kind: ShellKind = ShellKind.BASH
```

Approval matching requires canonical Shell tool name, matching command pattern, and matching active `SafetyPolicy.shell_profile.kind`. When a pending decision grants `ALLOW_SESSION`, construct the allowance from `decision.metadata["shell_kind"]`; missing legacy metadata defaults to Bash.

- [ ] **Step 4: Preserve backward compatibility in storage**

Readers default absent `shell_kind` to `bash`. Writers always persist it. Do not mutate historical pending approval records that have already completed.

- [ ] **Step 5: Run approval and storage tests**

```bash
uv run pytest tests/unit/services/test_approval_service.py tests/unit/services/test_session_service.py tests/unit/infrastructure/test_sqlite_session_store.py tests/unit/application/test_agent_runtime.py -q
uv run ruff check src/mycli/services/approval/approval_service.py src/mycli/application/turn_service.py src/mycli/application/runtime/turn_executor.py
```

- [ ] **Step 6: Commit**

```bash
git add src/mycli/domain/runtime/__init__.py src/mycli/services/approval/approval_service.py src/mycli/application/turn_service.py src/mycli/application/runtime/turn_executor.py src/mycli/application/runtime/agent_runtime.py tests/unit/services/test_approval_service.py tests/unit/services/test_session_service.py tests/unit/infrastructure/test_sqlite_session_store.py tests/unit/application/test_agent_runtime.py
git commit -m "Scope shell approvals by shell type"
```

## Task 8: Make Hooks Lint And Doctor Profile-Aware

**Files:**
- Modify: `src/mycli/services/hooks/config.py`
- Modify: `src/mycli/services/hooks/allowlist.py`
- Modify: `src/mycli/services/hooks/runner.py`
- Modify: `src/mycli/services/hooks/management.py`
- Modify: `src/mycli/tools/lint.py`
- Modify: `src/mycli/services/write_diagnostics.py`
- Modify: `src/mycli/services/diagnostics/doctor.py`
- Modify: `tests/unit/services/test_configured_hooks.py`
- Modify: `tests/unit/services/test_hook_management.py`
- Modify: `tests/unit/test_lint.py`
- Modify: `tests/unit/services/test_write_diagnostics.py`
- Modify: `tests/unit/services/test_doctor_service.py`

- [ ] **Step 1: Write failing consumer tests**

Cover:

```python
def test_string_hook_uses_active_powershell_profile(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.joinpath(".mycli").mkdir(parents=True)
    workspace.joinpath(".mycli", "hooks.json").write_text(
        json.dumps(
            {
                "hooks": [
                    {
                        "id": "repo-command",
                        "hook_point": "pre_tool_use",
                        "command": "Get-Location",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    registry = HookConfigRegistry(
        workspace_root=workspace,
        home_dir=home,
        shell_profile=powershell_core_profile(),
    )
    hook = registry.discover().hooks[0]
    assert hook.command[:5] == (
        "pwsh.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command"
    )
    assert hook.shell_kind is ShellKind.POWERSHELL


def test_argv_hook_remains_direct_and_has_no_shell_kind(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    workspace.joinpath(".mycli").mkdir(parents=True)
    workspace.joinpath(".mycli", "hooks.json").write_text(
        json.dumps(
            {
                "hooks": [
                    {
                        "id": "argv-command",
                        "hook_point": "pre_tool_use",
                        "command": [sys.executable, "-c", "print('ok')"],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    registry = HookConfigRegistry(
        workspace_root=workspace,
        home_dir=home,
        shell_profile=powershell_core_profile(),
    )
    hook = registry.discover().hooks[0]
    assert hook.command == (sys.executable, "-c", "print('ok')")
    assert hook.shell_kind is None


def test_hook_digest_changes_with_shell_kind() -> None:
    assert command_digest(command, ShellKind.BASH) != command_digest(command, ShellKind.POWERSHELL)


def test_doctor_reports_ignored_override_and_active_fallback(tmp_path: Path) -> None:
    resolution = ShellResolution(
        profile=ShellProfile(ShellKind.CMD, Path("cmd.exe")),
        explicit_path_status="ignored",
        explicit_path_reason="configured path does not exist",
    )
    report = DoctorService(
        workspace_root=tmp_path,
        home_dir=tmp_path,
        shell_resolution=resolution,
    ).run()
    check = next(item for item in report.checks if item.name == "tool_environment")
    assert "ignored" in check.detail
    assert "Command Prompt" in check.detail
```

Add lint tests proving built-in linters use argv, not a shell; configured compound lint strings use `profile.exec_argv()`.

- [ ] **Step 2: Run tests to verify RED**

```bash
uv run pytest tests/unit/services/test_configured_hooks.py tests/unit/services/test_hook_management.py tests/unit/test_lint.py tests/unit/services/test_write_diagnostics.py tests/unit/services/test_doctor_service.py -q
```

- [ ] **Step 3: Preserve hook command origin**

Add `shell_kind: ShellKind | None` to `ConfiguredHookSpec`. String commands are expanded with `shell_profile.exec_argv(script)` and retain the profile kind. List commands remain direct argv with `shell_kind=None`. Include shell kind in allowlist digests and management output; old allowlist entries without a kind match only legacy Bash string hooks.

- [ ] **Step 4: Prefer argv lint execution**

Represent built-in linter commands as tuples and pass them directly to `subprocess.run`. Only user/configured string commands use `ShellProfile.exec_argv`. Thread the profile through `LintTool` and `WriteDiagnosticsService` with `configure_shell_profile()`.

- [ ] **Step 5: Update Doctor**

Inject `ShellResolution`, report profile display name, accepted/ignored override status, and resolved path only in Doctor's user-facing details. Windows CMD fallback is healthy with a note that PowerShell provides richer command semantics; do not report missing Git Bash as a failure.

- [ ] **Step 6: Run focused and static checks**

```bash
uv run pytest tests/unit/services/test_configured_hooks.py tests/unit/services/test_hook_management.py tests/unit/test_lint.py tests/unit/services/test_write_diagnostics.py tests/unit/services/test_doctor_service.py -q
uv run ruff check src/mycli/services/hooks src/mycli/tools/lint.py src/mycli/services/write_diagnostics.py src/mycli/services/diagnostics/doctor.py
uv run mypy src/mycli/services/hooks src/mycli/tools/lint.py src/mycli/services/write_diagnostics.py src/mycli/services/diagnostics/doctor.py
```

- [ ] **Step 7: Commit**

```bash
git add src/mycli/services/hooks src/mycli/tools/lint.py src/mycli/services/write_diagnostics.py src/mycli/services/diagnostics/doctor.py tests/unit/services/test_configured_hooks.py tests/unit/services/test_hook_management.py tests/unit/test_lint.py tests/unit/services/test_write_diagnostics.py tests/unit/services/test_doctor_service.py
git commit -m "Use shell profiles in runtime consumers"
```

## Task 9: Persist And Render Shell Metadata

**Files:**
- Modify: `src/mycli/domain/runtime/shell_lifecycle.py`
- Modify: `src/mycli/services/transcript_projection.py`
- Modify: `src/mycli/cli/node_tui/gateway.py`
- Modify: `src/mycli/application/turn_service.py`
- Modify: `tui/mycli-shell/src/model.ts`
- Modify: `tui/mycli-shell/src/adapters/runtime-state.ts`
- Modify: `tui/mycli-shell/src/components/tool-display.ts`
- Modify: `tui/mycli-shell/src/components/tool-presentation.ts`
- Modify: `tests/unit/services/test_transcript_projection.py`
- Modify: `tests/unit/cli/node_tui/test_gateway.py`
- Modify: `tui/mycli-shell/test/runtime-state.test.ts`
- Modify: `tui/mycli-shell/test/shell-app.test.ts`

- [ ] **Step 1: Write failing persistence and TUI tests**

Python assertions:

```python
event = ShellLifecycleEvent(
    kind="shell.completed",
    shell_id="shell-1",
    owner_session_id="session-1",
    call_id="call-1",
    sequence=2,
    command_preview="Get-Location",
    background=False,
    process_state="completed",
    terminal_state="exited",
    exit_code=0,
    shell_kind="powershell",
    shell_edition="core",
)
payload = event.to_tui_payload()
assert payload["shell_kind"] == "powershell"
assert payload["shell_edition"] == "core"
assert "shell_path" not in payload
```

Node assertions:

```ts
assert.equal(canonicalToolName("Shell"), "Shell");
assert.equal(canonicalToolName("Bash"), "Bash");
assert.match(renderedExpandedDetails, /Shell: PowerShell 7/);
assert.match(renderedLegacyBashRecord, /Bash/);
```

- [ ] **Step 2: Run Python and Node tests to verify RED**

```bash
uv run pytest tests/unit/domain/runtime tests/unit/application -k shell -q
npm --prefix tui/mycli-shell test -- --test-name-pattern="Shell metadata|legacy Bash"
```

- [ ] **Step 3: Add stable metadata to lifecycle and persistence**

Add optional `shell_kind` and `shell_edition` fields to lifecycle events, transcript metadata, and background job projections. Never persist the executable path. Historical records remain unchanged; projection defaults to Bash only when historical `tool_name == "Bash"`.

- [ ] **Step 4: Update TUI canonicalization and details**

New `Shell`/`run_shell` activity labels as `Shell`; historical `Bash` remains `Bash`. Both share the existing shell visual accent and lifecycle command cell. Expanded details derive `PowerShell 7`, `Windows PowerShell 5.1`, `cmd`, `bash`, `zsh`, or `sh` from metadata.

- [ ] **Step 5: Run TUI, type, and session checks**

```bash
uv run pytest tests/unit/domain/runtime tests/unit/application -k shell -q
npm --prefix tui/mycli-shell test
npm --prefix tui/mycli-shell run typecheck
git diff --check
```

- [ ] **Step 6: Commit**

```bash
git add src/mycli/domain/runtime/shell_lifecycle.py src/mycli/services/transcript_projection.py src/mycli/cli/node_tui/gateway.py src/mycli/application/turn_service.py tui/mycli-shell/src/model.ts tui/mycli-shell/src/adapters/runtime-state.ts tui/mycli-shell/src/components/tool-display.ts tui/mycli-shell/src/components/tool-presentation.ts tests/unit/services/test_transcript_projection.py tests/unit/cli/node_tui/test_gateway.py tui/mycli-shell/test/runtime-state.test.ts tui/mycli-shell/test/shell-app.test.ts
git commit -m "Persist and render shell profile metadata"
```

## Task 10: Add Real Multi-Shell CI And Documentation

**Files:**
- Modify: `.github/workflows/cross-platform.yml`
- Modify: `tests/integration/test_cross_platform_shell.py`
- Modify: `README.md`
- Modify: `docs/windows.md`
- Modify: `docs/superpowers/specs/README.md`

- [ ] **Step 1: Parameterize lifecycle smoke tests by profile**

Create a helper that accepts an explicit `ShellProfile` and shell-specific commands. Cover foreground output, non-zero exit, background polling, timeout, interruption, and KillShell. Use these command sets:

```python
POSIX = ShellSmokeCommands(
    output="printf cross-platform",
    nonzero="exit 7",
    background="printf start; sleep 0.2; printf end",
    sleep="sleep 30",
)
POWERSHELL = ShellSmokeCommands(
    output="[Console]::Write('cross-platform')",
    nonzero="exit 7",
    background="[Console]::Write('start'); Start-Sleep -Milliseconds 200; [Console]::Write('end')",
    sleep="Start-Sleep -Seconds 30",
)
CMD = ShellSmokeCommands(
    output="<nul set /p =cross-platform",
    nonzero="exit /b 7",
    background="<nul set /p =start & ping -n 2 127.0.0.1 >nul & <nul set /p =end",
    sleep="ping -n 31 127.0.0.1 >nul",
)
```

All tests call the same public Shell lifecycle APIs with an injected profile.

- [ ] **Step 2: Run available local smoke tests**

```bash
uv run pytest tests/integration/test_cross_platform_shell.py -q
```

Expected on macOS: POSIX cases pass; unavailable Windows executables are skipped with an explicit reason.

- [ ] **Step 3: Expand the Windows CI matrix**

Keep Ubuntu and macOS jobs. Add Windows shell mode matrix entries:

```yaml
shell_mode: [pwsh, powershell, cmd]
```

Set `MYCLI_TEST_SHELL_MODE` for the integration test and run the full Python/Node suite once per OS, with the focused shell smoke repeated for each Windows mode. The `cmd` lane must inject `cmd.exe` even when PowerShell is installed, proving ultimate fallback behavior.

- [ ] **Step 4: Update user documentation**

Document:

- Git Bash is optional on Windows.
- Default order is PowerShell 7, Windows PowerShell 5.1, then CMD.
- Recognized explicit `shell_path` can select Bash, zsh, sh, PowerShell, or CMD.
- Invalid or unknown overrides are ignored and reported by Doctor.
- The model sees `Shell`, not platform-specific tool names.
- CMD is a supported fallback with more conservative approval behavior.

Add the spec and this plan to `docs/superpowers/specs/README.md`.

- [ ] **Step 5: Validate CI-facing references and docs**

```bash
uv run pytest tests/integration/test_cross_platform_shell.py -q
rg -n "PowerShell 7|Windows PowerShell 5.1|cmd.exe|Git Bash is optional|ShellOutput" README.md docs/windows.md
git diff --check
```

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/cross-platform.yml tests/integration/test_cross_platform_shell.py README.md docs/windows.md docs/superpowers/specs/README.md
git commit -m "Verify native shells across platforms"
```

## Task 11: Run Full Regression Verification

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

Expected: zero errors.

- [ ] **Step 3: Run all Node checks**

```bash
npm --prefix tui/mycli-shell test
npm --prefix tui/mycli-shell run typecheck
```

Expected: all tests and TypeScript checks pass.

- [ ] **Step 4: Run lifecycle and CLI smoke checks**

```bash
uv run pytest tests/integration/test_cross_platform_shell.py -q
uv run mycli --plain --help
```

- [ ] **Step 5: Scan for stale Bash-only runtime assumptions**

```bash
rg -n 'MODEL_VISIBLE_BUILTIN_TOOLS|through `Bash`|name = "Bash"|call\.name not in \{"Bash"|\[.*"-c".*command|shell=True' src/mycli tui/mycli-shell/src
```

Expected matches:

- hidden compatibility `BashTool` and `BashOutputTool` definitions;
- legacy migration tests or comments;
- POSIX argument derivation inside `ShellProfile`;
- no model-visible Bash schema, no unconditional `-c` session spawn, and no Python `shell=True`.

- [ ] **Step 6: Verify repository state and recent commits**

```bash
git diff --check
git status --short
git log --oneline -12
```

Expected: clean worktree and one focused commit per task.

- [ ] **Step 7: Finish the branch**

Use `superpowers:verification-before-completion`, then `superpowers:finishing-a-development-branch`. Do not merge, push, or delete the worktree without the user's selected finish option.
