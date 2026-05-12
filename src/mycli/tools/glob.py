from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from mycli.domain.tooling.calls import ToolCall, ToolResult
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec
from mycli.tools.path_utils import resolve_workspace_path


MAX_RESULTS = 200


def glob(pattern: str, path: str | None = None) -> dict[str, Any]:
    root = Path(path or os.getcwd()).resolve()
    matches = sorted(
        root.glob(pattern),
        key=lambda match: match.stat().st_mtime,
        reverse=True,
    )

    truncated = len(matches) > MAX_RESULTS
    shown_matches = matches[:MAX_RESULTS] if truncated else matches

    files: list[str] = []
    dirs: list[str] = []
    for match in shown_matches:
        relative = str(match.relative_to(root))
        if match.is_file():
            files.append(relative)
        elif match.is_dir():
            dirs.append(relative)

    return {
        "files": files,
        "dirs": dirs,
        "count": len(shown_matches),
        "truncated": truncated,
    }


class GlobTool:
    name = "Glob"
    spec = ToolSpec(
        name="Glob",
        description="Find files and directories by glob pattern, sorted by most recent modification time.",
        parameters=(
            ToolParameter(name="pattern", type="string", required=True),
            ToolParameter(name="path", type="string", required=False),
        ),
        risk_level="low",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def execute(self, arguments: dict[str, Any]) -> ToolResultV2:
        pattern = str(arguments.get("pattern") or "")
        if not pattern:
            return ToolResultV2(success=False, summary="Failed to glob", error="Glob requires pattern.")
        raw_path = str(arguments.get("path", "."))
        try:
            root = resolve_workspace_path(self._workspace_root, raw_path)
            payload = glob(pattern, path=str(root))
        except (OSError, ValueError) as exc:
            return ToolResultV2(success=False, summary="Failed to glob", error=str(exc))
        return ToolResultV2(
            success=True,
            summary=f"Found {payload['count']} glob match(es)",
            raw_payload={"path": raw_path, "pattern": pattern, **payload},
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()
