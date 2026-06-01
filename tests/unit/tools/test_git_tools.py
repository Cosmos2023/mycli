from __future__ import annotations

from pathlib import Path
import subprocess

from mycli.services.context.tool_result_formatter import ToolResultFormatter
from mycli.tools.git_tools import GitDiffTool, GitLogTool, GitShowTool, GitStatusTool


def test_git_status_reports_dirty_worktree(tmp_path: Path) -> None:
    _init_repo(tmp_path)
    (tmp_path / "notes.txt").write_text("draft\n", encoding="utf-8")

    result = GitStatusTool(tmp_path).execute({})

    assert result.success is True
    assert result.raw_payload["dirty"] is True
    assert result.raw_payload["entry_count"] == 1
    assert result.raw_payload["entries"] == [{"status": "??", "path": "notes.txt"}]


def test_git_diff_reports_bounded_diff_and_stat(tmp_path: Path) -> None:
    _init_repo(tmp_path)
    tracked = tmp_path / "app.py"
    tracked.write_text("print('old')\n", encoding="utf-8")
    _git(tmp_path, "add", "app.py")
    _git_commit(tmp_path, "initial")
    tracked.write_text("print('new')\n", encoding="utf-8")

    result = GitDiffTool(tmp_path).execute({"path": "app.py"})

    assert result.success is True
    assert "print('new')" in str(result.raw_payload["diff"])
    assert result.raw_payload["path"] == "app.py"
    assert result.raw_payload["staged"] is False
    assert isinstance(result.raw_payload["diff_chars"], int)


def test_git_log_returns_structured_commits(tmp_path: Path) -> None:
    _init_repo(tmp_path)
    (tmp_path / "README.md").write_text("hello\n", encoding="utf-8")
    _git(tmp_path, "add", "README.md")
    _git_commit(tmp_path, "initial commit")

    result = GitLogTool(tmp_path).execute({"limit": 5})

    assert result.success is True
    commits = result.raw_payload["commits"]
    assert isinstance(commits, list)
    assert commits[0]["subject"] == "initial commit"
    assert commits[0]["short_hash"]


def test_git_show_returns_revision_metadata(tmp_path: Path) -> None:
    _init_repo(tmp_path)
    (tmp_path / "README.md").write_text("hello\n", encoding="utf-8")
    _git(tmp_path, "add", "README.md")
    _git_commit(tmp_path, "initial commit")

    result = GitShowTool(tmp_path).execute({"ref": "HEAD"})

    assert result.success is True
    metadata = result.raw_payload["metadata"]
    assert metadata["subject"] == "initial commit"
    assert result.raw_payload["ref"] == "HEAD"


def test_git_tool_reports_non_git_workspace(tmp_path: Path) -> None:
    result = GitStatusTool(tmp_path).execute({})

    assert result.success is False
    assert result.raw_payload["error_kind"] == "not_git_repository"


def test_git_formatter_renders_compact_status(tmp_path: Path) -> None:
    _init_repo(tmp_path)
    formatter = ToolResultFormatter()
    result = GitStatusTool(tmp_path).execute({})

    output = formatter.format("GitStatus", result)

    assert "Git status" in output
    assert "Branch:" in output or "changed path" in output or "clean" in output


def _init_repo(path: Path) -> None:
    _git(path, "init")


def _git(path: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args],
        cwd=path,
        check=True,
        capture_output=True,
        text=True,
    )


def _git_commit(path: Path, message: str) -> None:
    subprocess.run(
        [
            "git",
            "-c",
            "user.name=Test User",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            message,
        ],
        cwd=path,
        check=True,
        capture_output=True,
        text=True,
    )
