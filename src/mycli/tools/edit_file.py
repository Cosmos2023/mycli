from __future__ import annotations

from difflib import unified_diff
from pathlib import Path

from mycli.domain.tools import ToolCall, ToolResult
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec


class EditFileTool:
    name = "edit_file"
    spec = ToolSpec(
        name="edit_file",
        description="Write new content to a workspace-relative file and return a diff preview.",
        parameters=(
            ToolParameter(name="path", type="string", required=True),
            ToolParameter(name="new_content", type="string", required=True),
        ),
        risk_level="medium",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def execute(self, arguments: dict[str, object]) -> ToolResultV2:
        path = str(arguments["path"])
        target = (self._workspace_root / path).resolve()
        before = target.read_text(encoding="utf-8") if target.exists() else ""
        after = str(arguments["new_content"])
        diff = "".join(
            unified_diff(
                before.splitlines(keepends=True),
                after.splitlines(keepends=True),
                fromfile=path,
                tofile=path,
            )
        )
        target.write_text(after, encoding="utf-8")
        return ToolResultV2(
            success=True,
            summary=f"Updated {path}",
            raw_payload={"diff": diff},
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()
