from pathlib import Path

import pytest

from mycli.domain.runtime import PowerShellEdition, ShellKind, ShellProfile


@pytest.mark.parametrize(
    ("profile", "command", "expected"),
    [
        (
            ShellProfile(ShellKind.BASH, Path("/bin/bash")),
            "printf ok",
            ["/bin/bash", "-c", "printf ok"],
        ),
        (
            ShellProfile(ShellKind.ZSH, Path("/bin/zsh")),
            "printf ok",
            ["/bin/zsh", "-c", "printf ok"],
        ),
        (
            ShellProfile(ShellKind.SH, Path("/bin/sh")),
            "printf ok",
            ["/bin/sh", "-c", "printf ok"],
        ),
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
def test_shell_profile_derives_exec_argv(
    profile: ShellProfile,
    command: str,
    expected: list[str],
) -> None:
    assert profile.exec_argv(command) == expected


def test_powershell_requires_edition() -> None:
    with pytest.raises(ValueError, match="edition"):
        ShellProfile(ShellKind.POWERSHELL, Path("pwsh.exe"))


def test_non_powershell_rejects_edition() -> None:
    with pytest.raises(ValueError, match="only valid"):
        ShellProfile(ShellKind.BASH, Path("/bin/bash"), PowerShellEdition.CORE)
