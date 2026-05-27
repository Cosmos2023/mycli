from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from mycli.cli.node_tui.process import (
    NodeTuiProcessError,
    build_node_command,
    node_tui_child_env,
    check_node_version,
    resolve_node_entrypoint,
)


def test_check_node_version_accepts_node_20() -> None:
    def runner(_cmd):
        return SimpleNamespace(returncode=0, stdout="v20.11.1\n", stderr="")

    assert check_node_version(runner=runner) == "v20.11.1"


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


def test_build_node_command_runs_tsx_shell_entrypoint(tmp_path: Path) -> None:
    node_root = tmp_path / "tui" / "node"
    entrypoint = node_root / "src" / "index.tsx"
    tsx_bin = node_root / "node_modules" / ".bin" / "tsx"
    entrypoint.parent.mkdir(parents=True)
    tsx_bin.parent.mkdir(parents=True)
    entrypoint.write_text("export {}", encoding="utf-8")
    tsx_bin.write_text("#!/usr/bin/env node\n", encoding="utf-8")

    assert build_node_command(repo_root=tmp_path, env={}) == [str(tsx_bin), str(entrypoint)]


def test_build_node_command_keeps_scripted_client_entrypoint(tmp_path: Path) -> None:
    node_root = tmp_path / "tui" / "node"
    scripted = node_root / "src" / "index.js"
    scripted.parent.mkdir(parents=True)
    scripted.write_text("console.log('scripted')", encoding="utf-8")

    command = build_node_command(repo_root=tmp_path, env={"MYCLI_NODE_TUI_SCRIPT": "[]"})

    assert command == ["node", str(scripted)]


def test_node_tui_child_env_respects_auto_color_environment() -> None:
    env = node_tui_child_env(
        base_env={"TERM": "dumb", "NO_COLOR": "1"},
        requested_env={},
    )

    assert env["TERM"] == "dumb"
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
