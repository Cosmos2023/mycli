from __future__ import annotations

from pathlib import Path
from typing import Any

from mycli.domain.tools import ToolCall, ToolResult
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec
from mycli.tools.filesystem import require_text_file, resolve_workspace_path


class AppendFileTool:
    name = "append_file"
    spec = ToolSpec(
        name="append_file",
        description="Append UTF-8 text content to a workspace file, creating it if needed.",
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
                raise ValueError("append_file requires string content.")
            target = resolve_workspace_path(self._workspace_root, path)
            if not target.parent.exists():
                raise ValueError("Parent directory does not exist.")
            require_text_file(target)
            existed = target.exists()
            before = target.read_text(encoding="utf-8") if existed else ""
            after = before + content
            target.write_text(after, encoding="utf-8")
        except (KeyError, OSError, UnicodeDecodeError, ValueError) as exc:
            return ToolResultV2(
                success=False,
                summary="Failed to append file",
                error=str(exc),
            )

        return ToolResultV2(
            success=True,
            summary=f"Appended {len(content)} chars to {path}",
            raw_payload={
                "path": path,
                "created": not existed,
                "before_size": len(before),
                "after_size": len(after),
                "appended_chars": len(content),
            },
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()
