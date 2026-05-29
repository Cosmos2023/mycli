from __future__ import annotations

import difflib
import re
from pathlib import Path
from typing import Any

from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec
from mycli.tools.file_snapshot import FileSnapshotStore, build_file_snapshot
from mycli.tools.path_utils import resolve_workspace_path


LINE_NUMBER_PATTERN = re.compile(r"^\s*\d+\t", re.MULTILINE)
MAX_EDIT_FILE_BYTES = 1_000_000
_SECRET_PATTERNS = (
    re.compile(r"sk-[A-Za-z0-9_-]{12,}"),
    re.compile(r"(?i)(api[_-]?key|secret|token|password)\s*=\s*['\"][^'\"]{8,}['\"]"),
)


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

    if old_string == new_string:
        raise EditError("Edit would be a no-op; old_string and new_string are identical.")

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


def _write_full_content(path: Path, content: str) -> dict[str, str]:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(content)
        return {"status": "created", "file": str(path)}
    if path.is_dir():
        raise EditError(f"Path is a directory: {path}")
    existing = path.read_text()
    if existing == content:
        return {"status": "unchanged", "file": str(path)}
    _backup(path, existing)
    path.write_text(content)
    return {"status": "overwritten", "file": str(path)}


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

    def __init__(
        self, workspace_root: Path, snapshot_store: FileSnapshotStore | None = None
    ) -> None:
        self._workspace_root = workspace_root
        self._snapshot_store = snapshot_store or FileSnapshotStore()

    def mutation_targets(self, arguments: dict[str, Any]) -> tuple[str, ...]:
        raw_path = str(arguments.get("file_path") or arguments.get("path") or "")
        if not raw_path:
            raise ValueError("Edit requires file_path.")
        legacy_content = arguments.get("new_content")
        if legacy_content is not None:
            if not isinstance(legacy_content, str):
                raise ValueError("Edit requires string new_content.")
            target = resolve_workspace_path(self._workspace_root, raw_path)
            try:
                if target.exists():
                    if target.is_dir():
                        raise ValueError(f"Path is a directory: {raw_path}")
                    if target.read_text() == legacy_content:
                        return ()
            except (OSError, UnicodeDecodeError) as exc:
                raise ValueError(str(exc)) from exc
            return (raw_path,)
        old_string = arguments.get("old_string", arguments.get("old_text"))
        new_string = arguments.get("new_string", arguments.get("new_text"))
        if (
            old_string is not None
            and new_string is not None
            and str(old_string) == str(new_string)
        ):
            return ()
        resolve_workspace_path(self._workspace_root, raw_path)
        return (raw_path,)

    def _validate_size(self, target: Path) -> tuple[bool, str | None]:
        size = target.stat().st_size
        if size > MAX_EDIT_FILE_BYTES:
            return False, f"File is too large to edit safely ({size} bytes)."
        return True, None

    def _contains_secret_like_content(self, value: str) -> bool:
        return any(pattern.search(value) is not None for pattern in _SECRET_PATTERNS)

    def _validate_snapshot(self, target: Path) -> tuple[bool, str | None, str | None]:
        relative_path = target.resolve().relative_to(self._workspace_root.resolve()).as_posix()
        snapshot = self._snapshot_store.latest(relative_path)
        if snapshot is None:
            return (
                False,
                "missing_read_snapshot",
                "Edit requires a recent Read of the target file before modifying it.",
            )
        current = build_file_snapshot(workspace_root=self._workspace_root, path=target)
        if (
            current.sha256 != snapshot.sha256
            or current.mtime_ns != snapshot.mtime_ns
            or current.size != snapshot.size
        ):
            return (
                False,
                "stale_read_snapshot",
                "File changed since last Read. Re-read the file and retry.",
            )
        return True, None, None

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        raw_path = str(arguments.get("file_path") or arguments.get("path") or "")
        try:
            if not raw_path:
                raise ValueError("Edit requires file_path.")
            target = resolve_workspace_path(self._workspace_root, raw_path)
            legacy_content = arguments.get("new_content")
            if isinstance(legacy_content, str):
                payload = _write_full_content(target, legacy_content)
                return ToolResult(
                    success=True,
                    summary=f"Edited {raw_path}",
                    raw_payload={"path": raw_path, **payload},
                )
            ok, error_kind, error_message = self._validate_snapshot(target)
            if not ok:
                return ToolResult(
                    success=False,
                    summary=f"Failed to edit {raw_path}",
                    error=error_message,
                    raw_payload={"path": raw_path, "error_kind": error_kind},
                )
            old_string = str(arguments.get("old_string", arguments.get("old_text", "")))
            new_string = str(arguments.get("new_string", arguments.get("new_text", "")))
            replace_all = bool(arguments.get("replace_all", False))
            size_ok, size_error = self._validate_size(target)
            if not size_ok:
                return ToolResult(
                    success=False,
                    summary=f"Failed to edit {raw_path}",
                    error=size_error,
                    raw_payload={"path": raw_path, "error_kind": "file_too_large"},
                )
            if self._contains_secret_like_content(new_string):
                return ToolResult(
                    success=False,
                    summary=f"Failed to edit {raw_path}",
                    error="New content looks like a secret. Refusing to write it.",
                    raw_payload={"path": raw_path, "error_kind": "secret_like_content"},
                )
            payload = edit_file(str(target), old_string, new_string, replace_all=replace_all)
        except (OSError, UnicodeDecodeError, ValueError, EditError) as exc:
            return ToolResult(
                success=False,
                summary=f"Failed to edit {raw_path}",
                error=str(exc),
                raw_payload={"path": raw_path},
            )

        return ToolResult(
            success=True,
            summary=f"Edited {raw_path}",
            raw_payload={"path": raw_path, **payload},
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)
