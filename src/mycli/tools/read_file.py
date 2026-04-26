from __future__ import annotations

from pathlib import Path

from mycli.domain.tools import ToolCall, ToolEvidence, ToolResult
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec
from mycli.tools.filesystem import (
    classify_filesystem_error,
    require_text_file,
    resolve_workspace_path,
)


class ReadFileTool:
    name = "read_file"
    spec = ToolSpec(
        name="read_file",
        description="Read a UTF-8 text file from the workspace.",
        parameters=(ToolParameter(name="path", type="string", required=True),),
        risk_level="low",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def execute(self, arguments: dict[str, object]) -> ToolResultV2:
        path = str(arguments["path"])
        try:
            target = resolve_workspace_path(self._workspace_root, path)
            require_text_file(target)
            content = target.read_text(encoding="utf-8")
        except (KeyError, OSError, UnicodeDecodeError, ValueError) as exc:
            return ToolResultV2(
                success=False,
                summary=f"Failed to read {path}",
                error=str(exc),
                raw_payload={
                    "path": path,
                    "error_kind": classify_filesystem_error(exc),
                },
            )
        line_count = len(content.splitlines())
        evidence: tuple[ToolEvidence, ...] = ()
        if content:
            evidence = (
                ToolEvidence(
                    kind="file_excerpt",
                    title=f"Excerpt from {path}",
                    path=path,
                    line_start=1,
                    line_end=line_count,
                    snippet=content,
                ),
            )
        return ToolResultV2(
            success=True,
            summary=f"Read {path}",
            raw_payload={"path": path, "content": content},
            evidence=evidence,
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()
