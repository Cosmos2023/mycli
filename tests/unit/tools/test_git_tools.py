import subprocess
from pathlib import Path

from mycli.domain.tools import ToolCall
from mycli.tools.git_diff import GitDiffTool
from mycli.tools.git_log import GitLogTool
from mycli.tools.git_status import GitStatusTool


def init_git_repo(path: Path) -> None:
    subprocess.run(["git", "init"], cwd=path, check=True, capture_output=True, text=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=path,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test User"],
        cwd=path,
        check=True,
        capture_output=True,
        text=True,
    )


def test_git_status_returns_branch_and_entries(tmp_path: Path) -> None:
    init_git_repo(tmp_path)
    (tmp_path / "README.md").write_text("hello\n", encoding="utf-8")

    tool = GitStatusTool(tmp_path)
    result = tool.run(ToolCall(name="git_status", arguments={}, reason="inspect repo"))

    assert result.success is True
    assert "entries" in result.raw_payload
    assert any("README.md" in entry for entry in result.raw_payload["entries"])


def test_git_diff_returns_diff_output(tmp_path: Path) -> None:
    init_git_repo(tmp_path)
    readme = tmp_path / "README.md"
    readme.write_text("hello\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=tmp_path, check=True, capture_output=True, text=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=tmp_path, check=True, capture_output=True, text=True)
    readme.write_text("hello world\n", encoding="utf-8")

    tool = GitDiffTool(tmp_path)
    result = tool.run(ToolCall(name="git_diff", arguments={}, reason="inspect diff"))

    assert result.success is True
    assert "diff" in result.raw_payload
    assert "+hello world" in result.raw_payload["diff"]


def test_git_log_returns_recent_commit_history(tmp_path: Path) -> None:
    init_git_repo(tmp_path)
    readme = tmp_path / "README.md"
    readme.write_text("hello\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.md"], cwd=tmp_path, check=True, capture_output=True, text=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=tmp_path, check=True, capture_output=True, text=True)

    tool = GitLogTool(tmp_path)
    result = tool.run(ToolCall(name="git_log", arguments={}, reason="inspect history"))

    assert result.success is True
    assert result.raw_payload["entries"]
    assert "init" in result.raw_payload["entries"][0]
