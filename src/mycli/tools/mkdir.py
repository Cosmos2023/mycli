from __future__ import annotations

from pathlib import Path
from typing import Any

from mycli.domain.tooling.calls import ToolCall, ToolResult
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec
from mycli.tools.filesystem import resolve_workspace_path


class MkdirTool:
    name = "mkdir"
    spec = ToolSpec(
        name="mkdir",
        description="Create a new directory. Use only when the directory does not already exist. Most file tools auto-create parent directories.",
        parameters=(ToolParameter(name="path", type="string", required=True),),
        risk_level="medium",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def execute(self, arguments: dict[str, Any]) -> ToolResultV2:
        try:
            path = str(arguments["path"])
            target = resolve_workspace_path(self._workspace_root, path)
            target.mkdir(parents=True, exist_ok=True)
        except (KeyError, OSError, ValueError) as exc:
            return ToolResultV2(success=False, summary="Failed to create directory", error=str(exc))

        return ToolResultV2(
            success=True,
            summary=f"Created directory {path}",
            raw_payload={"path": path},
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()
