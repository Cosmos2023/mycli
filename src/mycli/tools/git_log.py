from __future__ import annotations

from pathlib import Path
from typing import Any

from mycli.domain.tooling.calls import ToolCall, ToolResult
from mycli.infrastructure.shell_adapter import run_command
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec


class GitLogTool:
    name = "git_log"
    spec = ToolSpec(
        name="git_log",
        description="Show recent git commit history. Use to understand what changed recently. For uncommitted changes, use git_diff.",
        parameters=(ToolParameter(name="limit", type="integer", required=False),),
        risk_level="low",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def execute(self, arguments: dict[str, Any]) -> ToolResultV2:
        limit = int(arguments.get("limit", 10))
        completed = run_command(
            ["git", "log", f"-n{limit}", "--oneline"],
            cwd=self._workspace_root,
        )
        return ToolResultV2(
            success=completed.returncode == 0,
            summary="Loaded git log" if completed.returncode == 0 else "Failed to load git log",
            raw_payload={"entries": completed.stdout.splitlines(), "limit": limit},
            error=None if completed.returncode == 0 else completed.stderr,
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()
