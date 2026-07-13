from pathlib import Path

import pytest

from mycli.domain.runtime import PowerShellEdition, ShellKind, ShellProfile
from mycli.tools.shell_resolver import (
    ShellResolutionError,
    detect_shell_profile,
    detect_shell_profile_with_diagnostics,
    resolve_shell,
)


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


def test_invalid_explicit_shell_path_does_not_fall_back() -> None:
    with pytest.raises(ShellResolutionError, match="Configured shell_path does not exist"):
        resolve_shell(
            custom_shell_path="/missing/bash",
            platform_name="linux",
            env={"PATH": "/usr/bin"},
            path_exists=lambda _path: False,
            which=lambda _name, _path: "/usr/bin/bash",
        )


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


def test_windows_uses_case_insensitive_path_lookup() -> None:
    lookups: list[tuple[str, str | None]] = []

    resolved = resolve_shell(
        custom_shell_path=None,
        platform_name="win32",
        env={"Path": r"C:\Git\bin"},
        path_exists=lambda _path: False,
        which=lambda name, path: lookups.append((name, path)) or r"C:\Git\bin\bash.exe",
    )

    assert resolved.executable == Path(r"C:\Git\bin\bash.exe")
    assert lookups == [("bash.exe", r"C:\Git\bin")]


def test_windows_missing_bash_has_actionable_error() -> None:
    with pytest.raises(ShellResolutionError, match="Install Git for Windows") as exc_info:
        resolve_shell(
            custom_shell_path=None,
            platform_name="win32",
            env={"ProgramFiles": r"C:\Program Files"},
            path_exists=lambda _path: False,
            which=lambda _name, _path: None,
        )

    assert "MYCLI_SHELL_PATH" in str(exc_info.value)


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


def test_unix_falls_back_to_sh_on_path() -> None:
    resolved = resolve_shell(
        custom_shell_path=None,
        platform_name="linux",
        env={"PATH": "/custom/bin"},
        path_exists=lambda _path: False,
        which=lambda name, _path: "/custom/bin/sh" if name == "sh" else None,
    )

    assert resolved.executable == Path("/custom/bin/sh")


def test_unix_missing_shell_has_actionable_error() -> None:
    with pytest.raises(ShellResolutionError, match="No Bash-compatible shell"):
        resolve_shell(
            custom_shell_path=None,
            platform_name="linux",
            env={"PATH": "/empty"},
            path_exists=lambda _path: False,
            which=lambda _name, _path: None,
        )


def test_profile_detection_windows_prefers_pwsh() -> None:
    profile = detect_shell_profile(
        None,
        platform_name="win32",
        env={"PATH": "ignored"},
        path_exists=lambda _path: False,
        which=lambda name, _path: r"C:\Tools\pwsh.exe" if name == "pwsh" else None,
    )

    assert profile.kind is ShellKind.POWERSHELL
    assert profile.executable == Path(r"C:\Tools\pwsh.exe")
    assert profile.powershell_edition is PowerShellEdition.CORE


def test_profile_detection_windows_uses_desktop_fallback_path() -> None:
    desktop_path = Path(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")

    profile = detect_shell_profile(
        None,
        platform_name="win32",
        env={"SystemRoot": r"C:\Windows"},
        path_exists=lambda path: path == desktop_path,
        which=lambda _name, _path: None,
    )

    assert profile.kind is ShellKind.POWERSHELL
    assert profile.executable == desktop_path
    assert profile.powershell_edition is PowerShellEdition.DESKTOP


def test_profile_detection_windows_ultimate_fallback_is_cmd() -> None:
    profile = detect_shell_profile(
        None,
        platform_name="win32",
        env={},
        path_exists=lambda _path: False,
        which=lambda _name, _path: None,
    )

    assert profile == ShellProfile(ShellKind.CMD, Path("cmd.exe"))


@pytest.mark.parametrize(
    ("configured_path", "exists", "reason"),
    [
        (r"D:\missing\pwsh.exe", False, "does not exist"),
        (r"D:\tools\company-shell.exe", True, "not recognized"),
    ],
)
def test_profile_detection_ignores_unusable_explicit_path(
    configured_path: str,
    exists: bool,
    reason: str,
) -> None:
    resolution = detect_shell_profile_with_diagnostics(
        configured_path,
        platform_name="win32",
        env={},
        path_exists=lambda path: exists and str(path) == configured_path,
        which=lambda name, _path: "cmd.exe" if name in {"cmd", "cmd.exe"} else None,
    )

    assert resolution.profile.kind is ShellKind.CMD
    assert resolution.explicit_path_status == "ignored"
    assert resolution.explicit_path_reason is not None
    assert reason in resolution.explicit_path_reason


def test_profile_detection_accepts_recognized_explicit_path() -> None:
    explicit = Path(r"D:\tools\bash.exe")

    resolution = detect_shell_profile_with_diagnostics(
        str(explicit),
        platform_name="win32",
        env={},
        path_exists=lambda path: path == explicit,
        which=lambda _name, _path: None,
    )

    assert resolution.profile == ShellProfile(ShellKind.BASH, explicit)
    assert resolution.explicit_path_status == "accepted"
    assert resolution.explicit_path_reason is None


def test_profile_detection_macos_prefers_user_zsh() -> None:
    profile = detect_shell_profile(
        None,
        platform_name="darwin",
        env={},
        user_shell=lambda: Path("/bin/zsh"),
        path_exists=lambda path: path == Path("/bin/zsh"),
        which=lambda _name, _path: None,
    )

    assert profile == ShellProfile(ShellKind.ZSH, Path("/bin/zsh"))


def test_profile_detection_linux_falls_back_from_unknown_user_shell_to_bash() -> None:
    profile = detect_shell_profile(
        None,
        platform_name="linux",
        env={},
        user_shell=lambda: Path("/unsupported/fish"),
        path_exists=lambda path: path == Path("/bin/bash"),
        which=lambda _name, _path: None,
    )

    assert profile == ShellProfile(ShellKind.BASH, Path("/bin/bash"))
