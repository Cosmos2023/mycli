from __future__ import annotations

from pathlib import Path

from mycli.domain.tools import ToolCall, ToolResult
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec
from mycli.tools.filesystem import classify_filesystem_error, resolve_workspace_path


class ListDirectoryTool:
    name = "list_directory"
    spec = ToolSpec(
        name="list_directory",
        description="List entries in a workspace-relative directory.",
        parameters=(ToolParameter(name="path", type="string", required=True),),
        risk_level="low",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def execute(self, arguments: dict[str, object]) -> ToolResultV2:
        path = str(arguments.get("path", ""))
        try:
            target = resolve_workspace_path(self._workspace_root, path)
            if not target.exists():
                raise ValueError("Directory does not exist.")
            if not target.is_dir():
                raise ValueError("Expected a directory path.")
        except (KeyError, ValueError) as exc:
            return ToolResultV2(
                success=False,
                summary="Failed to list directory",
                error=str(exc),
                raw_payload={
                    "path": path,
                    "error_kind": classify_filesystem_error(exc),
                },
            )
        entries = sorted(path.name for path in target.iterdir())
        return ToolResultV2(
            success=True,
            summary=", ".join(entries),
            raw_payload={"path": path, "entries": entries},
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()
