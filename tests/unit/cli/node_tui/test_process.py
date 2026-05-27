from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from mycli.cli.node_tui.process import (
    NodeTuiProcessError,
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
