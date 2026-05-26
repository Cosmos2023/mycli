from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from mycli.cli.tui.marks import startup_mark
from mycli.cli.tui.status import format_bottom_status, workspace_label


def test_workspace_label_uses_workspace_name_for_worktree(tmp_path: Path) -> None:
    workspace = tmp_path / ".worktrees" / "fix-deepseek-cache-hit-rate"
    workspace.mkdir(parents=True)

    assert workspace_label(workspace) == "fix-deepseek-cache-hit-rate"


def test_format_bottom_status_uses_model_and_context_token_counts(tmp_path: Path) -> None:
    config = SimpleNamespace(
        workspace_root=tmp_path / "workspace",
        model="deepseek-v4-flash",
        max_prompt_tokens=12000,
    )
    snapshot = SimpleNamespace(
        context_window={
            "input_tokens": 3566,
            "max_tokens": 12000,
        }
    )

    assert format_bottom_status(config=config, snapshot=snapshot) == (
        "workspace · workspace",
        "deepseek-v4-flash · context 3,566 / 12,000 tokens",
    )


def test_format_bottom_status_falls_back_to_unknown_context(tmp_path: Path) -> None:
    config = SimpleNamespace(
        workspace_root=tmp_path / "workspace",
        model="gpt-test",
        max_prompt_tokens=12000,
    )
    snapshot = SimpleNamespace(context_window={})

    assert format_bottom_status(config=config, snapshot=snapshot) == (
        "workspace · workspace",
        "gpt-test · context unknown",
    )


def test_startup_mark_defaults_to_neutral_and_supports_zodiac() -> None:
    assert "mycli" in startup_mark("default")
    assert "(='.'=)" in startup_mark("rabbit")
    assert startup_mark("unknown") == startup_mark("default")
