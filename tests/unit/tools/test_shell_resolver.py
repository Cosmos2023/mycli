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
