from __future__ import annotations

from difflib import unified_diff
from pathlib import Path
from typing import Any

from mycli.domain.tools import ToolCall, ToolResult
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec
from mycli.tools.filesystem import require_text_file, resolve_workspace_path


class ReplaceInFileTool:
    name = "replace_in_file"
    spec = ToolSpec(
        name="replace_in_file",
        description="Replace exact text in a workspace file with optional match-count validation.",
        parameters=(
            ToolParameter(name="path", type="string", required=True),
            ToolParameter(name="old_text", type="string", required=True),
            ToolParameter(name="new_text", type="string", required=True),
            ToolParameter(name="expected_count", type="integer", required=False),
        ),
        risk_level="medium",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def execute(self, arguments: dict[str, Any]) -> ToolResultV2:
        try:
            path = str(arguments["path"])
            old_text = arguments["old_text"]
            new_text = arguments["new_text"]
            expected_count = arguments.get("expected_count")
            if not isinstance(old_text, str) or not old_text:
                raise ValueError("replace_in_file requires a non-empty old_text string.")
            if not isinstance(new_text, str):
                raise ValueError("replace_in_file requires string new_text.")
            if expected_count is not None:
                expected_count = int(expected_count)
            target = resolve_workspace_path(self._workspace_root, path)
            require_text_file(target)
            before = target.read_text(encoding="utf-8")
            replacement_count = before.count(old_text)
            if replacement_count == 0:
                raise ValueError("old_text was not found in the target file.")
            if expected_count is not None and replacement_count != expected_count:
                raise ValueError("expected_count does not match the number of occurrences.")
            after = before.replace(old_text, new_text)
            diff = "".join(
                unified_diff(
                    before.splitlines(keepends=True),
                    after.splitlines(keepends=True),
                    fromfile=path,
                    tofile=path,
                )
            )
            target.write_text(after, encoding="utf-8")
        except (KeyError, OSError, UnicodeDecodeError, ValueError) as exc:
            return ToolResultV2(
                success=False,
                summary="Failed to replace text in file",
                error=str(exc),
            )

        return ToolResultV2(
            success=True,
            summary=f"Replaced {replacement_count} occurrence in {path}",
            raw_payload={
                "path": path,
                "replacement_count": replacement_count,
                "diff": diff,
            },
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()
