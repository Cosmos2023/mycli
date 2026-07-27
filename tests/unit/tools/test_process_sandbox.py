from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path
import subprocess
import sys

import pytest

from mycli.domain.runtime import ExecutionPolicy, SandboxMode
from mycli.tools.process_sandbox import (
    LinuxBubblewrapProcessSandbox,
    MacOSSeatbeltProcessSandbox,
    ProcessSandboxUnavailable,
    WINDOWS_SANDBOX_PROTOCOL_VERSION,
    WINDOWS_SANDBOX_SETUP_REQUIRED,
    WindowsRestrictedTokenProcessSandbox,
    prepare_sandboxed_argv,
    process_sandbox_backend_profile,
)


def test_danger_full_access_keeps_host_command_unchanged(tmp_path: Path) -> None:
    policy = ExecutionPolicy.for_workspace(
        tmp_path,
        sandbox_mode=SandboxMode.DANGER_FULL_ACCESS,
    )

    launch = prepare_sandboxed_argv(
        ("/bin/sh", "-c", "printf ok"),
        sandbox=policy.sandbox,
        platform="darwin",
    )

    assert launch.argv == ("/bin/sh", "-c", "printf ok")
    assert launch.backend.isolation == "host_subprocess"


def test_danger_full_access_keeps_windows_command_unchanged(tmp_path: Path) -> None:
    policy = ExecutionPolicy.for_workspace(
        tmp_path,
        sandbox_mode=SandboxMode.DANGER_FULL_ACCESS,
    )

    launch = prepare_sandboxed_argv(
        ("cmd.exe", "/c", "echo ok"),
        sandbox=policy.sandbox,
        platform="win32",
    )

    assert launch.argv == ("cmd.exe", "/c", "echo ok")
    assert launch.backend.isolation == "host_subprocess"


def test_workspace_write_wraps_command_with_fixed_seatbelt_binary(
    tmp_path: Path,
) -> None:
    policy = ExecutionPolicy.for_workspace(tmp_path)
    backend = MacOSSeatbeltProcessSandbox(
        executable=Path("/usr/bin/sandbox-exec"),
        executable_exists=lambda _path: True,
    )

    launch = prepare_sandboxed_argv(
        ("/bin/sh", "-c", "printf ok"),
        sandbox=policy.sandbox,
        platform="darwin",
        macos_backend=backend,
    )

    assert launch.argv[0] == "/usr/bin/sandbox-exec"
    assert launch.argv[-3:] == ("/bin/sh", "-c", "printf ok")
    assert "--" in launch.argv
    assert any(
        argument == f"-DWRITABLE_ROOT_0={tmp_path.resolve()}"
        for argument in launch.argv
    )
    assert launch.backend.isolation == "macos_seatbelt"


def test_read_only_seatbelt_profile_has_no_writable_root(tmp_path: Path) -> None:
    policy = ExecutionPolicy.for_workspace(
        tmp_path,
        sandbox_mode=SandboxMode.READ_ONLY,
    )
    backend = MacOSSeatbeltProcessSandbox(
        executable=Path("/usr/bin/sandbox-exec"),
        executable_exists=lambda _path: True,
    )

    launch = prepare_sandboxed_argv(
        ("/usr/bin/true",),
        sandbox=policy.sandbox,
        platform="darwin",
        macos_backend=backend,
    )

    assert not any(argument.startswith("-DWRITABLE_ROOT_") for argument in launch.argv)


def test_workspace_write_seatbelt_protects_repository_metadata(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    policy = ExecutionPolicy.for_workspace(tmp_path)
    backend = MacOSSeatbeltProcessSandbox(
        executable_exists=lambda _path: True,
    )

    launch = backend.prepare(("/usr/bin/true",), sandbox=policy.sandbox)

    assert any(
        argument == f"-DPROTECTED_WRITE_ROOT_0={tmp_path.resolve() / '.git'}"
        for argument in launch.argv
    )
    profile = launch.argv[launch.argv.index("-p") + 1]
    assert '(deny file-write* (subpath (param "PROTECTED_WRITE_ROOT_0")))' in profile


def test_restricted_macos_mode_fails_closed_without_seatbelt(tmp_path: Path) -> None:
    policy = ExecutionPolicy.for_workspace(tmp_path)
    backend = MacOSSeatbeltProcessSandbox(
        executable=Path("/usr/bin/sandbox-exec"),
        executable_exists=lambda _path: False,
    )

    with pytest.raises(ProcessSandboxUnavailable, match="sandbox-exec"):
        prepare_sandboxed_argv(
            ("/usr/bin/true",),
            sandbox=policy.sandbox,
            platform="darwin",
            macos_backend=backend,
        )


def test_workspace_write_wraps_linux_command_with_fixed_bubblewrap_binary(
    tmp_path: Path,
) -> None:
    policy = ExecutionPolicy.for_workspace(tmp_path)
    backend = LinuxBubblewrapProcessSandbox(
        executable=Path("/usr/bin/bwrap"),
        executable_exists=lambda _path: True,
    )

    launch = prepare_sandboxed_argv(
        ("/bin/sh", "-c", "printf ok"),
        sandbox=policy.sandbox,
        platform="linux",
        linux_backend=backend,
    )

    assert launch.argv[0] == "/usr/bin/bwrap"
    assert launch.argv[-4:] == ("--", "/bin/sh", "-c", "printf ok")
    assert launch.backend.isolation == "linux_bubblewrap"


def test_workspace_write_rebinds_resolved_writable_root_on_linux(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    policy = ExecutionPolicy.for_workspace(workspace)
    backend = LinuxBubblewrapProcessSandbox(
        executable_exists=lambda _path: True,
    )

    launch = backend.prepare(("/usr/bin/true",), sandbox=policy.sandbox)

    writable = str(workspace.resolve())
    assert _argument_window_index(launch.argv, ("--bind", writable, writable)) > 0


def test_workspace_write_linux_reprotects_repository_metadata(tmp_path: Path) -> None:
    git_dir = tmp_path / ".git"
    git_dir.mkdir()
    policy = ExecutionPolicy.for_workspace(tmp_path)
    backend = LinuxBubblewrapProcessSandbox(
        executable_exists=lambda _path: True,
    )

    launch = backend.prepare(("/usr/bin/true",), sandbox=policy.sandbox)

    writable = str(tmp_path.resolve())
    git_path = str(git_dir.resolve())
    writable_index = _argument_window_index(launch.argv, ("--bind", writable, writable))
    protected_index = _argument_window_index(
        launch.argv,
        ("--ro-bind", git_path, git_path),
    )
    assert writable_index < protected_index


def test_read_only_linux_profile_has_no_writable_bind(tmp_path: Path) -> None:
    policy = ExecutionPolicy.for_workspace(
        tmp_path,
        sandbox_mode=SandboxMode.READ_ONLY,
    )
    backend = LinuxBubblewrapProcessSandbox(
        executable_exists=lambda _path: True,
    )

    launch = backend.prepare(("/usr/bin/true",), sandbox=policy.sandbox)

    assert "--bind" not in launch.argv
    assert launch.argv[1:6] == ("--new-session", "--die-with-parent", "--ro-bind", "/", "/")


def test_linux_bubblewrap_unshares_network_when_disabled(tmp_path: Path) -> None:
    policy = ExecutionPolicy.for_workspace(tmp_path)
    backend = LinuxBubblewrapProcessSandbox(
        executable_exists=lambda _path: True,
    )

    launch = backend.prepare(("/usr/bin/true",), sandbox=policy.sandbox)

    assert "--unshare-net" in launch.argv


def test_linux_bubblewrap_keeps_network_when_enabled(tmp_path: Path) -> None:
    policy = ExecutionPolicy.for_workspace(tmp_path)
    sandbox = replace(policy.sandbox, network="enabled")
    backend = LinuxBubblewrapProcessSandbox(
        executable_exists=lambda _path: True,
    )

    launch = backend.prepare(("/usr/bin/true",), sandbox=sandbox)

    assert "--unshare-net" not in launch.argv


def test_restricted_linux_mode_fails_closed_without_bubblewrap(tmp_path: Path) -> None:
    policy = ExecutionPolicy.for_workspace(tmp_path)
    backend = LinuxBubblewrapProcessSandbox(
        executable_exists=lambda _path: False,
    )

    with pytest.raises(ProcessSandboxUnavailable, match="Bubblewrap"):
        prepare_sandboxed_argv(
            ("/usr/bin/true",),
            sandbox=policy.sandbox,
            platform="linux",
            linux_backend=backend,
        )


def test_linux_masks_denied_paths_after_writable_mounts(tmp_path: Path) -> None:
    secret_root = tmp_path / "private"
    secret_root.mkdir()
    dotenv = tmp_path / ".env"
    dotenv.write_text("TOKEN=secret", encoding="utf-8")
    policy = ExecutionPolicy.for_workspace(tmp_path)
    sandbox = replace(
        policy.sandbox,
        denied_read_roots=(secret_root,),
        denied_read_globs=("**/.env",),
    )
    backend = LinuxBubblewrapProcessSandbox(
        executable_exists=lambda _path: True,
    )

    launch = backend.prepare(("/usr/bin/true",), sandbox=sandbox)

    writable = str(tmp_path.resolve())
    writable_index = _argument_window_index(launch.argv, ("--bind", writable, writable))
    root_mask_index = _argument_window_index(
        launch.argv,
        ("--perms", "000", "--tmpfs", str(secret_root.resolve())),
    )
    root_read_only_index = _argument_window_index(
        launch.argv,
        ("--remount-ro", str(secret_root.resolve())),
    )
    file_mask_index = _argument_window_index(
        launch.argv,
        ("--ro-bind", "/dev/null", str(dotenv.resolve())),
    )
    assert writable_index < root_mask_index
    assert root_mask_index < root_read_only_index
    assert writable_index < file_mask_index


def test_linux_resolves_relative_denied_root_from_sandbox_cwd(tmp_path: Path) -> None:
    secret_root = tmp_path / "private"
    secret_root.mkdir()
    policy = ExecutionPolicy.for_workspace(tmp_path)
    sandbox = replace(policy.sandbox, denied_read_roots=(Path("private"),))
    backend = LinuxBubblewrapProcessSandbox(
        executable_exists=lambda _path: True,
    )

    launch = backend.prepare(("/usr/bin/true",), sandbox=sandbox)

    assert _argument_window_index(
        launch.argv,
        ("--perms", "000", "--tmpfs", str(secret_root.resolve())),
    ) > 0


def test_linux_fails_closed_when_denied_path_crosses_writable_symlink(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "workspace"
    outside = tmp_path / "outside"
    workspace.mkdir()
    outside.mkdir()
    (outside / ".env").write_text("TOKEN=secret", encoding="utf-8")
    (workspace / "escape").symlink_to(outside, target_is_directory=True)
    policy = ExecutionPolicy.for_workspace(workspace)
    sandbox = replace(policy.sandbox, denied_read_globs=("escape/.env",))
    backend = LinuxBubblewrapProcessSandbox(
        executable_exists=lambda _path: True,
    )

    with pytest.raises(ProcessSandboxUnavailable, match="writable symlink"):
        backend.prepare(("/usr/bin/true",), sandbox=sandbox)


def test_linux_fails_closed_when_denied_glob_expands_too_broadly(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    policy = ExecutionPolicy.for_workspace(tmp_path)
    backend = LinuxBubblewrapProcessSandbox(
        executable_exists=lambda _path: True,
    )
    matches = (str(tmp_path / f"secret-{index}") for index in range(8_193))
    monkeypatch.setattr("mycli.tools.process_sandbox.glob.iglob", lambda *_args, **_kwargs: matches)
    monkeypatch.setattr(Path, "exists", lambda _path: True)
    monkeypatch.setattr(Path, "resolve", lambda path: path)

    with pytest.raises(ProcessSandboxUnavailable, match="more than 8192"):
        backend.prepare(("/usr/bin/true",), sandbox=policy.sandbox)


def test_linux_backend_profile_reports_availability(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "mycli.tools.process_sandbox._find_bubblewrap_executable",
        lambda: Path("/bin/bwrap"),
    )
    policy = ExecutionPolicy.for_workspace(Path("/workspace"))

    profile = process_sandbox_backend_profile(policy.sandbox, platform="linux")

    assert profile.available is True
    assert profile.isolation == "linux_bubblewrap"


def test_linux_backend_profile_reports_missing_bubblewrap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "mycli.tools.process_sandbox._find_bubblewrap_executable",
        lambda: None,
    )
    policy = ExecutionPolicy.for_workspace(Path("/workspace"))

    profile = process_sandbox_backend_profile(policy.sandbox, platform="linux")

    assert profile.available is False
    assert profile.isolation == "sandbox_unavailable"


def test_workspace_write_wraps_windows_command_with_packaged_helper(
    tmp_path: Path,
) -> None:
    policy = ExecutionPolicy.for_workspace(tmp_path)
    helper = tmp_path / "mycli-windows-sandbox.exe"
    backend = WindowsRestrictedTokenProcessSandbox(
        executable=helper,
        helper_status=lambda _path: (True, None),
    )

    launch = prepare_sandboxed_argv(
        ("cmd.exe", "/c", "echo ok"),
        sandbox=policy.sandbox,
        platform="win32",
        windows_backend=backend,
    )

    assert launch.argv[:2] == (str(helper), "--request-json")
    request = json.loads(launch.argv[2])
    assert request == {
        "protocol_version": WINDOWS_SANDBOX_PROTOCOL_VERSION,
        "command": {"argv": ["cmd.exe", "/c", "echo ok"]},
        "cwd": str(tmp_path.resolve()),
        "workspace_roots": [str(tmp_path.resolve())],
        "writable_roots": [str(tmp_path.resolve())],
        "denied_read_roots": [],
        "denied_read_globs": list(policy.sandbox.denied_read_globs),
        "filesystem": "workspace_write",
        "network": "disabled",
        "mode": "workspace-write",
    }
    assert launch.backend.isolation == "windows_restricted_token"


def test_windows_read_only_request_has_no_writable_roots(tmp_path: Path) -> None:
    policy = ExecutionPolicy.for_workspace(
        tmp_path,
        sandbox_mode=SandboxMode.READ_ONLY,
    )
    backend = WindowsRestrictedTokenProcessSandbox(
        executable=tmp_path / "mycli-windows-sandbox.exe",
        helper_status=lambda _path: (True, None),
    )

    launch = backend.prepare(("cmd.exe", "/c", "echo ok"), sandbox=policy.sandbox)

    request = json.loads(launch.argv[2])
    assert request["mode"] == "read-only"
    assert request["filesystem"] == "read_only"
    assert request["writable_roots"] == []


def test_restricted_windows_mode_fails_closed_without_helper(tmp_path: Path) -> None:
    policy = ExecutionPolicy.for_workspace(tmp_path)
    helper = tmp_path / "missing" / "mycli-windows-sandbox.exe"
    backend = WindowsRestrictedTokenProcessSandbox(
        executable=helper,
        helper_status=lambda path: (False, f"helper is unavailable: {path}"),
    )

    with pytest.raises(ProcessSandboxUnavailable, match="helper is unavailable"):
        prepare_sandboxed_argv(
            ("cmd.exe", "/c", "echo ok"),
            sandbox=policy.sandbox,
            platform="win32",
            windows_backend=backend,
        )


def test_restricted_windows_mode_fails_closed_on_protocol_mismatch(tmp_path: Path) -> None:
    policy = ExecutionPolicy.for_workspace(tmp_path)
    backend = WindowsRestrictedTokenProcessSandbox(
        executable=tmp_path / "mycli-windows-sandbox.exe",
        helper_status=lambda _path: (
            False,
            "helper protocol mismatch: expected 1, received 2",
        ),
    )

    with pytest.raises(ProcessSandboxUnavailable, match="protocol mismatch"):
        backend.prepare(("cmd.exe", "/c", "echo ok"), sandbox=policy.sandbox)


def test_windows_backend_runs_one_time_setup_then_rechecks_helper(tmp_path: Path) -> None:
    policy = ExecutionPolicy.for_workspace(tmp_path)
    statuses = iter(((False, WINDOWS_SANDBOX_SETUP_REQUIRED), (True, None)))
    setup_calls: list[Path] = []
    helper = tmp_path / "mycli-windows-sandbox.exe"
    backend = WindowsRestrictedTokenProcessSandbox(
        executable=helper,
        helper_status=lambda _path: next(statuses),
        helper_setup=lambda path: (setup_calls.append(path) is None, None),
    )

    launch = backend.prepare(("cmd.exe", "/c", "echo ok"), sandbox=policy.sandbox)

    assert setup_calls == [helper]
    assert launch.backend.isolation == "windows_restricted_token"


def test_windows_backend_fails_closed_when_elevated_setup_is_cancelled(
    tmp_path: Path,
) -> None:
    policy = ExecutionPolicy.for_workspace(tmp_path)
    backend = WindowsRestrictedTokenProcessSandbox(
        executable=tmp_path / "mycli-windows-sandbox.exe",
        helper_status=lambda _path: (False, WINDOWS_SANDBOX_SETUP_REQUIRED),
        helper_setup=lambda _path: (False, "setup cancelled"),
    )

    with pytest.raises(ProcessSandboxUnavailable, match="setup cancelled"):
        backend.prepare(("cmd.exe", "/c", "echo ok"), sandbox=policy.sandbox)


@pytest.mark.skipif(sys.platform == "win32", reason="fixture uses a POSIX executable script")
def test_windows_helper_handshake_accepts_ready_protocol(tmp_path: Path) -> None:
    helper = _write_handshake_helper(
        tmp_path,
        {
            "name": "mycli-windows-sandbox",
            "protocol_version": WINDOWS_SANDBOX_PROTOCOL_VERSION,
            "sandbox_ready": True,
        },
    )
    policy = ExecutionPolicy.for_workspace(tmp_path)
    backend = WindowsRestrictedTokenProcessSandbox(executable=helper)

    launch = backend.prepare(("cmd.exe", "/c", "echo ok"), sandbox=policy.sandbox)

    assert launch.backend.isolation == "windows_restricted_token"


@pytest.mark.skipif(sys.platform == "win32", reason="fixture uses a POSIX executable script")
def test_windows_helper_handshake_rejects_wrong_protocol(tmp_path: Path) -> None:
    helper = _write_handshake_helper(
        tmp_path,
        {
            "name": "mycli-windows-sandbox",
            "protocol_version": WINDOWS_SANDBOX_PROTOCOL_VERSION + 1,
            "sandbox_ready": True,
        },
    )
    policy = ExecutionPolicy.for_workspace(tmp_path)
    backend = WindowsRestrictedTokenProcessSandbox(executable=helper)

    with pytest.raises(ProcessSandboxUnavailable, match="protocol mismatch"):
        backend.prepare(("cmd.exe", "/c", "echo ok"), sandbox=policy.sandbox)


@pytest.mark.skipif(sys.platform == "win32", reason="fixture uses a POSIX executable script")
def test_windows_helper_handshake_rejects_not_ready_backend(tmp_path: Path) -> None:
    helper = _write_handshake_helper(
        tmp_path,
        {
            "name": "mycli-windows-sandbox",
            "protocol_version": WINDOWS_SANDBOX_PROTOCOL_VERSION,
            "sandbox_ready": False,
        },
    )
    policy = ExecutionPolicy.for_workspace(tmp_path)
    backend = WindowsRestrictedTokenProcessSandbox(executable=helper)

    with pytest.raises(ProcessSandboxUnavailable, match="not ready"):
        backend.prepare(("cmd.exe", "/c", "echo ok"), sandbox=policy.sandbox)


def test_windows_backend_profile_reports_restricted_token_when_helper_is_ready(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    policy = ExecutionPolicy.for_workspace(tmp_path)
    monkeypatch.setattr(
        "mycli.tools.process_sandbox._windows_sandbox_helper_status",
        lambda _path: (True, None),
    )

    profile = process_sandbox_backend_profile(policy.sandbox, platform="win32")

    assert profile.available is True
    assert profile.isolation == "windows_restricted_token"


def test_windows_backend_profile_reports_sandbox_unavailable_for_invalid_helper(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    policy = ExecutionPolicy.for_workspace(tmp_path)
    monkeypatch.setattr(
        "mycli.tools.process_sandbox._windows_sandbox_helper_status",
        lambda _path: (False, "helper protocol mismatch"),
    )

    profile = process_sandbox_backend_profile(policy.sandbox, platform="win32")

    assert profile.available is False
    assert profile.isolation == "sandbox_unavailable"


def _argument_window_index(argv: tuple[str, ...], window: tuple[str, ...]) -> int:
    for index in range(len(argv) - len(window) + 1):
        if argv[index : index + len(window)] == window:
            return index
    return -1


def _write_handshake_helper(tmp_path: Path, response: dict[str, object]) -> Path:
    helper = tmp_path / "mycli-windows-sandbox.exe"
    payload = json.dumps(response)
    helper.write_text(
        "#!/bin/sh\n"
        "if [ \"$1\" = \"--handshake\" ]; then\n"
        f"  printf '%s\\n' '{payload}'\n"
        "  exit 0\n"
        "fi\n"
        "exit 1\n",
        encoding="utf-8",
    )
    helper.chmod(0o755)
    return helper


@pytest.mark.skipif(
    not sys.platform.startswith("linux")
    or not any(
        path.is_file() and path.stat().st_mode & 0o111
        for path in (Path("/usr/bin/bwrap"), Path("/bin/bwrap"))
    ),
    reason="requires Linux Bubblewrap",
)
def test_workspace_write_enforces_file_boundary_with_bubblewrap(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside.txt"
    policy = ExecutionPolicy.for_workspace(workspace)
    inside_launch = prepare_sandboxed_argv(
        ("/bin/sh", "-c", "printf inside > inside.txt"),
        sandbox=policy.sandbox,
    )
    outside_launch = prepare_sandboxed_argv(
        ("/bin/sh", "-c", f"printf outside > {outside}"),
        sandbox=policy.sandbox,
    )

    inside = subprocess.run(inside_launch.argv, cwd=workspace, check=False)
    outside_result = subprocess.run(outside_launch.argv, cwd=workspace, check=False)

    assert inside.returncode == 0
    assert (workspace / "inside.txt").read_text(encoding="utf-8") == "inside"
    assert outside_result.returncode != 0
    assert not outside.exists()


@pytest.mark.skipif(sys.platform != "darwin", reason="requires macOS Seatbelt")
def test_workspace_write_enforces_file_boundary_in_os(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside.txt"
    policy = ExecutionPolicy.for_workspace(workspace)

    inside_launch = prepare_sandboxed_argv(
        ("/bin/sh", "-c", "printf inside > inside.txt"),
        sandbox=policy.sandbox,
    )
    outside_launch = prepare_sandboxed_argv(
        ("/bin/sh", "-c", f"printf outside > {outside}"),
        sandbox=policy.sandbox,
    )

    inside = subprocess.run(inside_launch.argv, cwd=workspace, check=False)
    outside_result = subprocess.run(outside_launch.argv, cwd=workspace, check=False)

    assert inside.returncode == 0
    assert (workspace / "inside.txt").read_text(encoding="utf-8") == "inside"
    assert outside_result.returncode != 0
    assert not outside.exists()


@pytest.mark.skipif(sys.platform != "darwin", reason="requires macOS Seatbelt")
def test_workspace_write_blocks_symlink_escape(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    outside = tmp_path / "outside"
    workspace.mkdir()
    outside.mkdir()
    (workspace / "escape").symlink_to(outside, target_is_directory=True)
    policy = ExecutionPolicy.for_workspace(workspace)
    launch = prepare_sandboxed_argv(
        ("/bin/sh", "-c", "printf blocked > escape/file.txt"),
        sandbox=policy.sandbox,
    )

    result = subprocess.run(launch.argv, cwd=workspace, check=False)

    assert result.returncode != 0
    assert not (outside / "file.txt").exists()


@pytest.mark.skipif(sys.platform != "darwin", reason="requires macOS Seatbelt")
def test_workspace_write_blocks_denied_reads_and_network(tmp_path: Path) -> None:
    secret = tmp_path / ".env"
    secret.write_text("TOKEN=secret", encoding="utf-8")
    policy = ExecutionPolicy.for_workspace(tmp_path)
    read_launch = prepare_sandboxed_argv(
        ("/bin/cat", str(secret)),
        sandbox=policy.sandbox,
    )
    network_launch = prepare_sandboxed_argv(
        (
            sys.executable,
            "-c",
            "import socket; raise SystemExit(socket.socket().connect_ex(('127.0.0.1', 9)) != 1)",
        ),
        sandbox=policy.sandbox,
    )

    read_result = subprocess.run(read_launch.argv, cwd=tmp_path, check=False)
    network_result = subprocess.run(network_launch.argv, cwd=tmp_path, check=False)

    assert read_result.returncode != 0
    assert network_result.returncode == 0


@pytest.mark.skipif(sys.platform != "darwin", reason="requires macOS Seatbelt")
def test_denied_read_glob_character_class_is_enforced(tmp_path: Path) -> None:
    secret = tmp_path / "secret"
    secret.write_text("hidden", encoding="utf-8")
    policy = ExecutionPolicy.for_workspace(tmp_path)
    sandbox = replace(policy.sandbox, denied_read_globs=("**/[s]ecret",))
    launch = prepare_sandboxed_argv(
        ("/bin/cat", str(secret)),
        sandbox=sandbox,
    )

    result = subprocess.run(launch.argv, cwd=tmp_path, check=False)

    assert result.returncode != 0
