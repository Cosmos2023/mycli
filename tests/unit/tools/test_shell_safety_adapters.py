from pathlib import Path

import pytest

from mycli.domain.runtime import PowerShellEdition, ShellKind, ShellProfile
from mycli.tools.shell_safety import ShellRiskLevel, analyze_shell_command
from mycli.tools.shell_safety_adapters import analyze_shell_for_profile


def _powershell() -> ShellProfile:
    return ShellProfile(
        ShellKind.POWERSHELL,
        Path("pwsh.exe"),
        PowerShellEdition.CORE,
    )


def _cmd() -> ShellProfile:
    return ShellProfile(ShellKind.CMD, Path("cmd.exe"))


def test_posix_adapter_preserves_existing_analysis() -> None:
    profile = ShellProfile(ShellKind.BASH, Path("/bin/bash"))
    command = "git push origin main"

    assert analyze_shell_for_profile(profile, command) == analyze_shell_command(command)


@pytest.mark.parametrize("profile", [_powershell(), _cmd()])
def test_unknown_windows_construct_requires_confirmation(profile: ShellProfile) -> None:
    analysis = analyze_shell_for_profile(profile, "opaque $(dynamic) expression")

    assert analysis.risk_level is ShellRiskLevel.CONFIRM
    assert analysis.command_pattern is None


@pytest.mark.parametrize(
    ("command", "pattern"),
    [
        ("Get-Location", "Get-Location"),
        ("Get-ChildItem -Force", "Get-ChildItem"),
        ("git status --short", "git status"),
    ],
)
def test_powershell_read_only_commands_are_allowed(command: str, pattern: str) -> None:
    analysis = analyze_shell_for_profile(_powershell(), command)

    assert analysis.risk_level is ShellRiskLevel.ALLOW
    assert analysis.command_pattern == pattern


def test_powershell_read_only_pipeline_is_allowed() -> None:
    analysis = analyze_shell_for_profile(
        _powershell(),
        "Get-ChildItem -Force | Select-Object Name",
    )

    assert analysis.risk_level is ShellRiskLevel.ALLOW


@pytest.mark.parametrize(
    "command",
    [
        "Remove-Item -Recurse -Force .\\build",
        "Stop-Process -Name python -Force",
        "git reset --hard HEAD~1",
    ],
)
def test_powershell_destructive_commands_require_confirmation(command: str) -> None:
    analysis = analyze_shell_for_profile(_powershell(), command)

    assert analysis.risk_level in {ShellRiskLevel.CONFIRM, ShellRiskLevel.DENY}


@pytest.mark.parametrize("command", ["$env:TEMP", "Get-Date > date.txt", "Get-Date | Out-File date.txt"])
def test_powershell_dynamic_or_mutating_constructs_require_confirmation(command: str) -> None:
    analysis = analyze_shell_for_profile(_powershell(), command)

    assert analysis.risk_level is ShellRiskLevel.CONFIRM
    assert analysis.command_pattern is None


@pytest.mark.parametrize(
    ("command", "pattern"),
    [("dir /a", "dir"), ("where git", "where"), ("git diff --stat", "git diff")],
)
def test_cmd_read_only_commands_are_allowed(command: str, pattern: str) -> None:
    analysis = analyze_shell_for_profile(_cmd(), command)

    assert analysis.risk_level is ShellRiskLevel.ALLOW
    assert analysis.command_pattern == pattern


def test_cmd_read_only_composition_is_allowed() -> None:
    analysis = analyze_shell_for_profile(_cmd(), "cd src && dir | findstr py")

    assert analysis.risk_level is ShellRiskLevel.ALLOW


@pytest.mark.parametrize(
    "command",
    ["del /s /q build", "taskkill /f /im python.exe", "git clean -fdx"],
)
def test_cmd_destructive_commands_require_confirmation(command: str) -> None:
    analysis = analyze_shell_for_profile(_cmd(), command)

    assert analysis.risk_level in {ShellRiskLevel.CONFIRM, ShellRiskLevel.DENY}


@pytest.mark.parametrize("command", ["echo %PATH%", "dir > files.txt", 'dir "unterminated'])
def test_cmd_expansion_redirection_and_parse_failure_require_confirmation(command: str) -> None:
    analysis = analyze_shell_for_profile(_cmd(), command)

    assert analysis.risk_level is ShellRiskLevel.CONFIRM
    assert analysis.command_pattern is None
