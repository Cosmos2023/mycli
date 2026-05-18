from __future__ import annotations

from pathlib import Path
from typing import Any

from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec
from mycli.tools.path_utils import resolve_workspace_path


def write_file(file_path: str, content: str) -> dict[str, Any]:
    path = Path(file_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    existed = path.exists()
    if existed:
        if path.is_dir():
            return {"error": f"[Path is a directory: {file_path}]"}
        existing = path.read_text()
        if existing == content:
            return {"status": "unchanged", "file": str(path)}
        _backup(path, existing)

    path.write_text(content)
    return {"status": "overwritten" if existed else "created", "file": str(path)}


def _backup(path: Path, content: str) -> None:
    backup_dir = path.parent / ".mycli_backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"{path.name}.bak"
    backup_path.write_text(content)


class WriteTool:
    name = "Write"
    spec = ToolSpec(
        name="Write",
        description="Write a complete file, creating parent directories and backing up existing content before overwrite.",
        parameters=(
            ToolParameter(name="file_path", type="string", required=True),
            ToolParameter(name="content", type="string", required=True),
        ),
        risk_level="medium",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        raw_path = str(arguments.get("file_path") or arguments.get("path") or "")
        try:
            if not raw_path:
                raise ValueError("Write requires file_path.")
            content = arguments.get("content", arguments.get("new_content"))
            if not isinstance(content, str):
                raise ValueError("Write requires string content.")
            target = resolve_workspace_path(self._workspace_root, raw_path)
            payload = write_file(str(target), content)
        except (OSError, UnicodeDecodeError, ValueError) as exc:
            return ToolResult(
                success=False,
                summary=f"Failed to write {raw_path}",
                error=str(exc),
                raw_payload={"path": raw_path},
            )

        success = "error" not in payload
        return ToolResult(
            success=success,
            summary=f"Wrote {raw_path}" if success else f"Failed to write {raw_path}",
            error=str(payload["error"]) if "error" in payload else None,
            raw_payload={"path": raw_path, **payload},
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)
