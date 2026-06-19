import os
from pathlib import Path

from mycli.domain.runtime import ShellEnvironmentPolicy
from mycli.tools import shell_environment
from mycli.tools.shell_environment import create_shell_environment


def test_create_shell_environment_sanitized_core_with_workspace_pwd(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(shell_environment, "prepend_ripgrep_to_path", lambda path: (path or "", None))
    source = {
        "HOME": "/home/user",
        "LANG": "en_US.UTF-8",
        "PATH": "/usr/bin",
        "MYCLI_TOKEN": "secret",
        "CUSTOM": "value",
        "PWD": "/outside",
    }

    env = create_shell_environment(
        ShellEnvironmentPolicy.sanitized(workspace_root=tmp_path),
        source_env=source,
    )

    assert env == {
        "HOME": "/home/user",
        "LANG": "en_US.UTF-8",
        "PATH": "/usr/bin",
        "PWD": str(tmp_path),
    }


def test_create_shell_environment_inherit_all_keeps_parent_values(
    monkeypatch,
) -> None:
    monkeypatch.setattr(shell_environment, "prepend_ripgrep_to_path", lambda path: (path or "", None))
    source = {
        "PATH": "/usr/bin",
        "CUSTOM": "value",
        "API_TOKEN": "secret",
    }

    env = create_shell_environment(
        ShellEnvironmentPolicy.inherit_all(),
        source_env=source,
    )

    assert env["CUSTOM"] == "value"
    assert env["API_TOKEN"] == "secret"


def test_create_shell_environment_filters_and_sets_values(
    monkeypatch,
) -> None:
    monkeypatch.setattr(shell_environment, "prepend_ripgrep_to_path", lambda path: (path or "", None))
    source = {
        "PATH": "/usr/bin",
        "HOME": "/home/user",
        "API_TOKEN": "secret",
        "CUSTOM_SECRET": "secret",
        "KEEP_ME": "keep",
    }

    env = create_shell_environment(
        ShellEnvironmentPolicy(
            inherit="all",
            exclude=("CUSTOM_*",),
            set={"CI": "false"},
            include_only=("PATH", "CI", "MYCLI_THREAD_ID"),
            thread_id="thread-123",
        ),
        source_env=source,
    )

    assert env == {
        "PATH": "/usr/bin",
        "CI": "false",
        "MYCLI_THREAD_ID": "thread-123",
    }


def test_create_shell_environment_prepends_prepared_ripgrep(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        shell_environment,
        "prepend_ripgrep_to_path",
        lambda path: (f"/vendor/rg{os.pathsep}{path}", "/vendor/rg"),
    )

    env = create_shell_environment(
        ShellEnvironmentPolicy.sanitized(workspace_root=Path("/repo")),
        source_env={"PATH": "/usr/bin"},
    )

    assert env["PATH"] == f"/vendor/rg{os.pathsep}/usr/bin"
    assert env["MYCLI_RIPGREP_PATH_DIR"] == "/vendor/rg"
