from __future__ import annotations

from pathlib import Path
from typing import Any

from mycli.domain.tools import ToolCall, ToolEvidence, ToolResult
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec
from mycli.tools.filesystem import (
    classify_filesystem_error,
    require_text_file,
    resolve_workspace_path,
)


class ReadFileRangeTool:
    name = "read_file_range"
    spec = ToolSpec(
        name="read_file_range",
        description="Read an inclusive line range from a UTF-8 text file in the workspace.",
        parameters=(
            ToolParameter(name="path", type="string", required=True),
            ToolParameter(name="start_line", type="integer", required=True),
            ToolParameter(name="end_line", type="integer", required=True),
        ),
        risk_level="low",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def execute(self, arguments: dict[str, Any]) -> ToolResultV2:
        try:
            start_line = int(arguments["start_line"])
            end_line = int(arguments["end_line"])
            if start_line < 1 or end_line < start_line:
                raise ValueError("Line range must be 1-based and end_line >= start_line.")
            path = str(arguments["path"])
            target = resolve_workspace_path(self._workspace_root, path)
            require_text_file(target)
            content = target.read_text(encoding="utf-8")
        except (KeyError, OSError, UnicodeDecodeError, ValueError) as exc:
            return ToolResultV2(
                success=False,
                summary="Failed to read file range",
                error=str(exc),
                raw_payload={
                    "path": str(arguments.get("path", "")),
                    "start_line": arguments.get("start_line"),
                    "end_line": arguments.get("end_line"),
                    "error_kind": classify_filesystem_error(exc),
                },
            )

        lines = content.splitlines(keepends=True)
        snippet = "".join(lines[start_line - 1 : end_line])
        actual_end_line = min(end_line, len(lines))
        evidence: tuple[ToolEvidence, ...] = ()
        if snippet:
            evidence = (
                ToolEvidence(
                    kind="file_excerpt",
                    title=f"{path}:{start_line}-{actual_end_line}",
                    path=path,
                    line_start=start_line,
                    line_end=actual_end_line,
                    snippet=snippet,
                ),
            )
        return ToolResultV2(
            success=True,
            summary=f"Read lines {start_line}-{end_line} from {path}",
            raw_payload={
                "path": path,
                "start_line": start_line,
                "end_line": end_line,
                "actual_start_line": start_line,
                "actual_end_line": actual_end_line,
                "content": snippet,
            },
            evidence=evidence,
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()
