from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from mycli.cli.node_tui.process import (
    NodeTuiProcess,
    NodeTuiProcessError,
    build_node_command,
    build_node_setup_command,
    node_tui_child_env,
    check_node_version,
    resolve_node_entrypoint,
)


class BrokenPipeOnClose:
    closed = False

    def close(self) -> None:
        self.closed = True
        raise BrokenPipeError


class FakePopenWithBrokenPipeClose:
    def __init__(self) -> None:
        self.stdin = BrokenPipeOnClose()
        self.stdout = BrokenPipeOnClose()
        self.terminated = False

    def poll(self) -> int | None:
        return None

    def terminate(self) -> None:
        self.terminated = True

    def wait(self) -> int:
        return 0


def test_check_node_version_accepts_node_20() -> None:
    def runner(_cmd):
        return SimpleNamespace(returncode=0, stdout="v20.11.1\n", stderr="")

    assert check_node_version(runner=runner) == "v20.11.1"


def test_node_tui_process_terminate_suppresses_broken_pipe_during_pipe_close() -> None:
    process = NodeTuiProcess(args=["node", "fake.js"], env={}, cwd=Path.cwd())
    popen = FakePopenWithBrokenPipeClose()
    stdin = popen.stdin
    stdout = popen.stdout
    process._process = popen  # pyright: ignore[reportPrivateUsage]

    process.terminate()

    assert stdin.closed is True
    assert stdout.closed is True
    assert popen.terminated is True
    assert process._process is None  # pyright: ignore[reportPrivateUsage]


def test_check_node_version_rejects_old_node() -> None:
    def runner(_cmd):
        return SimpleNamespace(returncode=0, stdout="v18.19.0\n", stderr="")

    with pytest.raises(NodeTuiProcessError, match="Node TUI requires Node.js >= 20"):
        check_node_version(runner=runner)


def test_check_node_version_reports_missing_node() -> None:
    def runner(_cmd):
        raise FileNotFoundError

    with pytest.raises(NodeTuiProcessError, match="Use mycli --plain or install Node"):
        check_node_version(runner=runner)


def test_resolve_node_entrypoint_prefers_env_override(tmp_path: Path) -> None:
    script = tmp_path / "fake-node.js"
    script.write_text("console.log('ok')", encoding="utf-8")

    assert resolve_node_entrypoint(
        repo_root=tmp_path,
        env={"MYCLI_NODE_TUI_ENTRYPOINT": str(script)},
    ) == script


def test_resolve_node_entrypoint_reports_missing_default(tmp_path: Path) -> None:
    with pytest.raises(NodeTuiProcessError, match="Node TUI entrypoint not found"):
        resolve_node_entrypoint(repo_root=tmp_path, env={})


def test_build_node_command_defaults_to_mycli_shell_gateway(tmp_path: Path) -> None:
    node_root = tmp_path / "tui" / "mycli-shell"
    tsx_bin = node_root / "node_modules" / ".bin" / "tsx"
    shell_entrypoint = tmp_path / "tui" / "mycli-shell" / "src" / "gateway.ts"
    tsx_bin.parent.mkdir(parents=True)
    shell_entrypoint.parent.mkdir(parents=True)
    tsx_bin.write_text("#!/usr/bin/env node\n", encoding="utf-8")
    shell_entrypoint.write_text("export {}", encoding="utf-8")

    assert build_node_command(repo_root=tmp_path, env={}) == [str(tsx_bin), str(shell_entrypoint)]


def test_build_node_command_uses_tsx_cmd_on_windows(tmp_path: Path) -> None:
    node_root = tmp_path / "tui" / "mycli-shell"
    tsx_bin = node_root / "node_modules" / ".bin" / "tsx.cmd"
    shell_entrypoint = node_root / "src" / "gateway.ts"
    tsx_bin.parent.mkdir(parents=True)
    shell_entrypoint.parent.mkdir(parents=True)
    tsx_bin.write_text("@node tsx", encoding="utf-8")
    shell_entrypoint.write_text("export {}", encoding="utf-8")

    assert build_node_command(
        repo_root=tmp_path,
        env={},
        platform_name="win32",
    ) == [str(tsx_bin), str(shell_entrypoint)]


def test_build_node_setup_command_runs_setup_tui_entrypoint(tmp_path: Path) -> None:
    node_root = tmp_path / "tui" / "mycli-shell"
    tsx_bin = node_root / "node_modules" / ".bin" / "tsx"
    setup_entrypoint = node_root / "src" / "setup.ts"
    tsx_bin.parent.mkdir(parents=True)
    setup_entrypoint.parent.mkdir(parents=True)
    tsx_bin.write_text("#!/usr/bin/env node\n", encoding="utf-8")
    setup_entrypoint.write_text("export {}", encoding="utf-8")

    assert build_node_setup_command(repo_root=tmp_path, env={}) == [str(tsx_bin), str(setup_entrypoint)]


def test_build_node_setup_command_uses_tsx_cmd_on_windows(tmp_path: Path) -> None:
    node_root = tmp_path / "tui" / "mycli-shell"
    tsx_bin = node_root / "node_modules" / ".bin" / "tsx.cmd"
    setup_entrypoint = node_root / "src" / "setup.ts"
    tsx_bin.parent.mkdir(parents=True)
    setup_entrypoint.parent.mkdir(parents=True)
    tsx_bin.write_text("@node tsx", encoding="utf-8")
    setup_entrypoint.write_text("export {}", encoding="utf-8")

    assert build_node_setup_command(
        repo_root=tmp_path,
        env={},
        platform_name="win32",
    ) == [str(tsx_bin), str(setup_entrypoint)]


def test_build_node_command_maps_legacy_ink_backend_to_mycli_shell(tmp_path: Path) -> None:
    node_root = tmp_path / "tui" / "mycli-shell"
    entrypoint = node_root / "src" / "gateway.ts"
    tsx_bin = node_root / "node_modules" / ".bin" / "tsx"
    entrypoint.parent.mkdir(parents=True)
    tsx_bin.parent.mkdir(parents=True)
    entrypoint.write_text("export {}", encoding="utf-8")
    tsx_bin.write_text("#!/usr/bin/env node\n", encoding="utf-8")

    command = build_node_command(repo_root=tmp_path, env={"MYCLI_TUI_BACKEND": "ink"})

    assert command == [str(tsx_bin), str(entrypoint)]


def test_build_node_command_can_run_mycli_shell_gateway_backend(tmp_path: Path) -> None:
    node_root = tmp_path / "tui" / "mycli-shell"
    tsx_bin = node_root / "node_modules" / ".bin" / "tsx"
    shell_entrypoint = tmp_path / "tui" / "mycli-shell" / "src" / "gateway.ts"
    tsx_bin.parent.mkdir(parents=True)
    shell_entrypoint.parent.mkdir(parents=True)
    tsx_bin.write_text("#!/usr/bin/env node\n", encoding="utf-8")
    shell_entrypoint.write_text("export {}", encoding="utf-8")

    command = build_node_command(repo_root=tmp_path, env={"MYCLI_TUI_BACKEND": "shell"})

    assert command == [str(tsx_bin), str(shell_entrypoint)]


def test_build_node_command_reports_missing_mycli_shell_gateway_backend(tmp_path: Path) -> None:
    node_root = tmp_path / "tui" / "mycli-shell"
    tsx_bin = node_root / "node_modules" / ".bin" / "tsx"
    tsx_bin.parent.mkdir(parents=True)
    tsx_bin.write_text("#!/usr/bin/env node\n", encoding="utf-8")

    with pytest.raises(NodeTuiProcessError, match="mycli-shell gateway entrypoint not found"):
        build_node_command(repo_root=tmp_path, env={"MYCLI_TUI_BACKEND": "shell"})


def test_build_node_command_rejects_unknown_tui_backend(tmp_path: Path) -> None:
    with pytest.raises(NodeTuiProcessError, match="Unsupported MYCLI_TUI_BACKEND"):
        build_node_command(repo_root=tmp_path, env={"MYCLI_TUI_BACKEND": "unknown"})


def test_build_node_command_keeps_scripted_client_entrypoint(tmp_path: Path) -> None:
    node_root = tmp_path / "tui" / "mycli-shell"
    scripted = node_root / "test" / "support" / "scripted-client.ts"
    tsx_bin = node_root / "node_modules" / ".bin" / "tsx"
    scripted.parent.mkdir(parents=True)
    tsx_bin.parent.mkdir(parents=True)
    scripted.write_text("console.log('scripted')", encoding="utf-8")
    tsx_bin.write_text("#!/usr/bin/env node\n", encoding="utf-8")

    command = build_node_command(repo_root=tmp_path, env={"MYCLI_NODE_TUI_SCRIPT": "[]"})

    assert command == [str(tsx_bin), str(scripted)]


def test_node_tui_child_env_forces_color_by_default() -> None:
    env = node_tui_child_env(
        base_env={"TERM": "xterm-256color"},
        requested_env={},
    )

    assert env["TERM"] == "xterm-256color"
    assert env["FORCE_COLOR"] == "3"
    assert "NO_COLOR" not in env


def test_node_tui_child_env_respects_no_color_by_default() -> None:
    env = node_tui_child_env(
        base_env={"TERM": "xterm-256color", "NO_COLOR": "1"},
        requested_env={},
    )

    assert env["NO_COLOR"] == "1"
    assert "FORCE_COLOR" not in env


def test_node_tui_child_env_can_force_color_for_node_ink() -> None:
    env = node_tui_child_env(
        base_env={"TERM": "dumb", "NO_COLOR": "1"},
        requested_env={"MYCLI_TUI_COLOR": "always"},
    )

    assert env["FORCE_COLOR"] == "3"
    assert "NO_COLOR" not in env


def test_node_tui_child_env_can_force_no_color() -> None:
    env = node_tui_child_env(
        base_env={"TERM": "xterm-256color", "FORCE_COLOR": "3"},
        requested_env={"MYCLI_TUI_COLOR": "never"},
    )

    assert env["NO_COLOR"] == "1"
    assert "FORCE_COLOR" not in env
