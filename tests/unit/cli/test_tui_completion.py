from __future__ import annotations

from pathlib import Path

from mycli.cli.tui.completion import CompletionState, slash_command_candidates


def test_slash_command_candidates_include_required_and_tui_only_commands() -> None:
    candidates = slash_command_candidates()

    assert "/status" in candidates
    assert "/view focus" in candidates
    assert "/status usage" in candidates
    assert "/status context" in candidates
    assert "/status stats" in candidates
    assert "/session resume <session>" in candidates
    assert "/session maintenance" in candidates
    assert "/session maintenance --apply-orphans" in candidates
    assert "/session maintenance --apply-vacuum" in candidates
    assert "/session search <query>" in candidates
    assert "/clear" in candidates
    assert "/theme" in candidates
    assert "/mark <name>" in candidates
    assert "/release-notes" in candidates
    assert "/tools" in candidates
    assert "/tools hooks" in candidates
    assert "/tools sets" in candidates
    assert "/jobs bashes" in candidates
    assert "/changes" in candidates
    assert "/changes undo" in candidates
    assert "/plan" in candidates
    assert "/tools extensions" in candidates
    assert "/jobs subagents" in candidates
    assert "/memory" in candidates
    assert "/trace" in candidates
    assert "/trace export" in candidates
    assert "/trace logs" in candidates
    assert "/session fork [source] <new-session> [message-index]" in candidates
    assert "/usage" not in candidates
    assert "/sessions" not in candidates
    assert "/model" not in candidates
    assert "/init" not in candidates
    assert "/diff" not in candidates


def test_completion_state_filters_slash_commands_by_prefix() -> None:
    state = CompletionState(workspace_root=Path.cwd())

    state.update("/sta")

    assert state.visible is True
    assert state.candidates[:2] == ("/status", "/status usage")
    assert state.selected == "/status"


def test_completion_state_arrow_selection_and_tab_accept() -> None:
    state = CompletionState(workspace_root=Path.cwd())
    state.update("/sta")

    state.move_selection(1)

    assert state.selected == "/status usage"
    assert state.accept_selected() == "/status usage"
    assert state.visible is False


def test_completion_state_esc_closes_without_changing_input() -> None:
    state = CompletionState(workspace_root=Path.cwd())
    state.update("/sta")

    assert state.close() is None
    assert state.visible is False


def test_completion_state_offers_workspace_path_candidates(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "README.md").write_text("hi", encoding="utf-8")

    state = CompletionState(workspace_root=workspace)
    state.update("@R")

    assert state.candidates == ("@README.md",)
    assert state.accept_selected() == "@README.md"
