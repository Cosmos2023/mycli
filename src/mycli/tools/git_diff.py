from __future__ import annotations

from pathlib import Path
from typing import Any

from mycli.domain.tools import ToolCall, ToolResult
from mycli.infrastructure.shell_adapter import run_command
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec


class GitDiffTool:
    name = "git_diff"
    spec = ToolSpec(
        name="git_diff",
        description="Inspect git diff in the current workspace or for a specific path.",
        parameters=(ToolParameter(name="path", type="string", required=False),),
        risk_level="low",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def execute(self, arguments: dict[str, Any]) -> ToolResultV2:
        args = ["git", "diff", "--no-ext-diff", "--"]
        path = arguments.get("path")
        if isinstance(path, str) and path:
            args.append(path)
        else:
            args = ["git", "diff", "--no-ext-diff"]
        completed = run_command(args, cwd=self._workspace_root)
        return ToolResultV2(
            success=completed.returncode == 0,
            summary="Loaded git diff" if completed.returncode == 0 else "Failed to load git diff",
            raw_payload={"diff": completed.stdout, "path": path},
            error=None if completed.returncode == 0 else completed.stderr,
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()
