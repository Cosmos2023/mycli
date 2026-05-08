from __future__ import annotations

from pathlib import Path

from mycli.domain.tooling.calls import ToolCall, ToolResult
from mycli.infrastructure.shell_adapter import run_command
from mycli.tools.base import ToolResultV2, ToolSpec


class GitStatusTool:
    name = "git_status"
    spec = ToolSpec(
        name="git_status",
        description="Show current git status (modified, staged, untracked files). Use to check repo state before starting work. For change details, use git_diff.",
        risk_level="low",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def execute(self, arguments: dict[str, object]) -> ToolResultV2:
        del arguments
        completed = run_command(["git", "status", "--short", "--branch"], cwd=self._workspace_root)
        return ToolResultV2(
            success=completed.returncode == 0,
            summary="Loaded git status" if completed.returncode == 0 else "Failed to load git status",
            raw_payload={"stdout": completed.stdout, "entries": completed.stdout.splitlines()},
            error=None if completed.returncode == 0 else completed.stderr,
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()
