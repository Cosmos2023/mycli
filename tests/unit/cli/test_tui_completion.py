from __future__ import annotations

from pathlib import Path

from mycli.cli.tui.completion import CompletionState, slash_command_candidates


def test_slash_command_candidates_include_required_and_tui_only_commands() -> None:
    candidates = slash_command_candidates()

    assert "/status" in candidates
    assert "/view focus" in candidates
    assert "/resume <session>" in candidates
    assert "/session-maintenance" in candidates
    assert "/session-maintenance --apply-orphans" in candidates
    assert "/session-maintenance --apply-vacuum" in candidates
    assert "/search <query>" in candidates
    assert "/clear" in candidates
    assert "/theme" in candidates
    assert "/mark <name>" in candidates
    assert "/release-notes" in candidates
    assert "/tools" in candidates
    assert "/toolsets" in candidates
    assert "/bashes" in candidates
    assert "/changes" in candidates
    assert "/undo" in candidates
    assert "/plan" in candidates
    assert "/extensions" in candidates
    assert "/subagents" in candidates
    assert "/memory" in candidates
    assert "/trace" in candidates
    assert "/trace-jsonl" in candidates
    assert "/logs" in candidates
    assert "/fork [source] <new-session> [message-index]" in candidates
    assert "/model" not in candidates
    assert "/init" not in candidates
    assert "/diff" not in candidates


def test_completion_state_filters_slash_commands_by_prefix() -> None:
    state = CompletionState(workspace_root=Path.cwd())

    state.update("/sta")

    assert state.visible is True
    assert state.candidates[:2] == ("/status", "/stats")
    assert state.selected == "/status"


def test_completion_state_arrow_selection_and_tab_accept() -> None:
    state = CompletionState(workspace_root=Path.cwd())
    state.update("/sta")

    state.move_selection(1)

    assert state.selected == "/stats"
    assert state.accept_selected() == "/stats"
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
