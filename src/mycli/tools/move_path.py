from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from mycli.domain.tooling.calls import ToolCall, ToolResult
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec
from mycli.tools.filesystem import resolve_workspace_path


class MovePathTool:
    name = "move_path"
    spec = ToolSpec(
        name="move_path",
        description="Move or rename a file or directory. Verify both source and destination paths before calling.",
        parameters=(
            ToolParameter(name="source", type="string", required=True),
            ToolParameter(name="destination", type="string", required=True),
        ),
        risk_level="medium",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def execute(self, arguments: dict[str, Any]) -> ToolResultV2:
        try:
            source = resolve_workspace_path(self._workspace_root, str(arguments["source"]))
            destination = resolve_workspace_path(self._workspace_root, str(arguments["destination"]))
            if not source.exists():
                raise ValueError("Source path does not exist.")
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(destination))
        except (KeyError, OSError, ValueError) as exc:
            return ToolResultV2(success=False, summary="Failed to move path", error=str(exc))

        return ToolResultV2(
            success=True,
            summary=f"Moved {arguments['source']} to {arguments['destination']}",
            raw_payload={"source": arguments["source"], "destination": arguments["destination"]},
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()
