from __future__ import annotations

import difflib
import re
from pathlib import Path
from typing import Any

from mycli.domain.tooling.calls import ToolCall, ToolResult
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec
from mycli.tools.path_utils import resolve_workspace_path


LINE_NUMBER_PATTERN = re.compile(r"^\s*\d+\t", re.MULTILINE)


class EditError(Exception):
    """Raised when an edit cannot be applied safely."""


def edit_file(
    file_path: str,
    old_string: str,
    new_string: str,
    replace_all: bool = False,
) -> dict[str, Any]:
    path = Path(file_path)
    old_string = _preprocess(old_string, path)

    if old_string == "":
        return _write_empty_old_string(path, new_string)

    if not path.exists():
        raise EditError(f"File does not exist: {file_path}")
    if path.is_dir():
        raise EditError(f"Path is a directory: {file_path}")

    content = path.read_text()
    count = content.count(old_string)
    if count == 0:
        raise EditError(
            "String not found in file. The file may have changed since you "
            "last read it. Re-read the file and try again."
        )
    if count > 1 and not replace_all:
        raise EditError(
            f"Multiple matches ({count}) found. Add more surrounding context "
            "to make the old_string unique (include 3-5 lines before and after)."
        )

    new_content = (
        content.replace(old_string, new_string)
        if replace_all
        else content.replace(old_string, new_string, 1)
    )

    _backup(path, content)
    path.write_text(new_content)
    diff = "\n".join(
        difflib.unified_diff(
            content.splitlines(),
            new_content.splitlines(),
            fromfile=f"{file_path}:before",
            tofile=f"{file_path}:after",
            lineterm="",
        )
    )

    return {
        "status": "edited",
        "file": str(path),
        "matches": count if replace_all else 1,
        "diff": diff,
    }


def _write_empty_old_string(path: Path, new_string: str) -> dict[str, str]:
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(new_string)
        return {"status": "created", "file": str(path)}

    if path.is_dir():
        raise EditError(f"Path is a directory: {path}")

    content = path.read_text()
    if content.strip():
        raise EditError(
            "File has existing content. Use Edit with old_string to modify, "
            "or Write to overwrite the entire file."
        )

    _backup(path, content)
    path.write_text(new_string)
    return {"status": "written", "file": str(path)}


def _preprocess(text: str, path: Path) -> str:
    text = LINE_NUMBER_PATTERN.sub("", text)
    if path.suffix.lower() not in {".md", ".mdx"}:
        text = text.rstrip(" \t\r")
    return text


def _backup(path: Path, content: str) -> None:
    backup_dir = path.parent / ".mycli_backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"{path.name}.bak"
    backup_path.write_text(content)


class EditTool:
    name = "Edit"
    spec = ToolSpec(
        name="Edit",
        description="Apply an exact old_string/new_string edit. old_string must uniquely match unless replace_all is true.",
        parameters=(
            ToolParameter(name="file_path", type="string", required=True),
            ToolParameter(name="old_string", type="string", required=True),
            ToolParameter(name="new_string", type="string", required=True),
            ToolParameter(name="replace_all", type="boolean", required=False),
        ),
        risk_level="medium",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def execute(self, arguments: dict[str, Any]) -> ToolResultV2:
        raw_path = str(arguments.get("file_path") or arguments.get("path") or "")
        try:
            if not raw_path:
                raise ValueError("Edit requires file_path.")
            target = resolve_workspace_path(self._workspace_root, raw_path)
            old_string = str(arguments.get("old_string", arguments.get("old_text", "")))
            new_string = str(arguments.get("new_string", arguments.get("new_text", "")))
            replace_all = bool(arguments.get("replace_all", False))
            payload = edit_file(str(target), old_string, new_string, replace_all=replace_all)
        except (OSError, UnicodeDecodeError, ValueError, EditError) as exc:
            return ToolResultV2(
                success=False,
                summary=f"Failed to edit {raw_path}",
                error=str(exc),
                raw_payload={"path": raw_path},
            )

        return ToolResultV2(
            success=True,
            summary=f"Edited {raw_path}",
            raw_payload={"path": raw_path, **payload},
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments).to_legacy()
