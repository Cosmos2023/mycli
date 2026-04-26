from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from mycli.domain.tools import ToolCall, ToolResult
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec
from mycli.tools.filesystem import resolve_workspace_path


class DeletePathTool:
    name = "delete_path"
    spec = ToolSpec(
        name="delete_path",
        description="Delete a file or directory within the workspace.",
        parameters=(ToolParameter(name="path", type="string", required=True),),
        risk_level="medium",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def execute(self, arguments: dict[str, Any]) -> ToolResultV2:
        try:
            path = str(arguments["path"])
            target = resolve_workspace_path(self._workspace_root, path)
            if not target.exists():
                raise ValueError("Target path does not exist.")
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
        except (KeyError, OSError, ValueError) as exc:
            return ToolResultV2(success=False, summary="Failed to delete path", error=str(exc))

        return ToolResultV2(
            success=True,
            summary=f"Deleted {path}",
            raw_payload={"path": path},
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()
