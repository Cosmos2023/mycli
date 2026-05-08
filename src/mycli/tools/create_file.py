from __future__ import annotations

from pathlib import Path
from typing import Any

from mycli.domain.tooling.calls import ToolCall, ToolResult
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec
from mycli.tools.filesystem import require_text_file, resolve_workspace_path


class CreateFileTool:
    name = "create_file"
    spec = ToolSpec(
        name="create_file",
        description="Create a new file. Use only when the file does not already exist. To modify an existing file, use edit_file or replace_in_file.",
        parameters=(
            ToolParameter(name="path", type="string", required=True),
            ToolParameter(name="content", type="string", required=True),
        ),
        risk_level="medium",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def execute(self, arguments: dict[str, Any]) -> ToolResultV2:
        try:
            path = str(arguments["path"])
            content = arguments["content"]
            if not isinstance(content, str):
                raise ValueError("create_file requires string content.")
            target = resolve_workspace_path(self._workspace_root, path)
            if not target.parent.exists():
                raise ValueError("Parent directory does not exist.")
            require_text_file(target)
            if target.exists():
                raise ValueError("Target file already exists.")
            target.write_text(content, encoding="utf-8")
        except (KeyError, OSError, UnicodeDecodeError, ValueError) as exc:
            return ToolResultV2(success=False, summary="Failed to create file", error=str(exc))

        return ToolResultV2(
            success=True,
            summary=f"Created {path}",
            raw_payload={"path": path, "content": content},
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()
