from __future__ import annotations

from pathlib import Path
from typing import Any

from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec
from mycli.tools.file_mutation import (
    backup_file,
    unified_diff,
    validate_content_safety,
    validate_expected_sha256,
    validate_text_write_target,
)
from mycli.tools.path_utils import resolve_workspace_path


def write_file(file_path: str, content: str) -> dict[str, Any]:
    path = Path(file_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    existed = path.exists()
    existing = ""
    if existed:
        existing = path.read_text()
        if existing == content:
            return {"status": "unchanged", "file": str(path), "diff": ""}
        backup_file(path, existing)

    path.write_text(content)
    return {
        "status": "overwritten" if existed else "created",
        "file": str(path),
        "diff": unified_diff(
            before=existing,
            after=content,
            fromfile=f"{file_path}:before",
            tofile=f"{file_path}:after",
        ),
    }


class WriteTool:
    name = "Write"
    spec = ToolSpec(
        name="Write",
        description="Write a complete file, creating parent directories and backing up existing content before overwrite.",
        parameters=(
            ToolParameter(name="file_path", type="string", required=True),
            ToolParameter(name="content", type="string", required=True),
            ToolParameter(name="expected_sha256", type="string", required=False),
        ),
        risk_level="medium",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def mutation_targets(self, arguments: dict[str, Any]) -> tuple[str, ...]:
        raw_path = str(arguments.get("file_path") or arguments.get("path") or "")
        if not raw_path:
            raise ValueError("Write requires file_path.")
        content = arguments.get("content", arguments.get("new_content"))
        if not isinstance(content, str):
            raise ValueError("Write requires string content.")
        target = resolve_workspace_path(self._workspace_root, raw_path)
        try:
            if target.exists():
                if target.is_dir():
                    raise ValueError(f"Path is a directory: {raw_path}")
                if target.read_text() == content:
                    return ()
        except (OSError, UnicodeDecodeError) as exc:
            raise ValueError(str(exc)) from exc
        return (raw_path,)

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        raw_path = str(arguments.get("file_path") or arguments.get("path") or "")
        try:
            if not raw_path:
                raise ValueError("Write requires file_path.")
            content = arguments.get("content", arguments.get("new_content"))
            if not isinstance(content, str):
                raise ValueError("Write requires string content.")
            target = resolve_workspace_path(self._workspace_root, raw_path)
            ok, error_kind, error_message = validate_text_write_target(target)
            if not ok:
                return ToolResult(
                    success=False,
                    summary=f"Failed to write {raw_path}",
                    error=error_message,
                    raw_payload={"path": raw_path, "error_kind": error_kind},
                )
            ok, error_kind, error_message = validate_content_safety(content)
            if not ok:
                return ToolResult(
                    success=False,
                    summary=f"Failed to write {raw_path}",
                    error=error_message,
                    raw_payload={"path": raw_path, "error_kind": error_kind},
                )
            ok, error_kind, error_message = validate_expected_sha256(
                workspace_root=self._workspace_root,
                target=target,
                expected_sha256=arguments.get("expected_sha256"),
            )
            if not ok:
                return ToolResult(
                    success=False,
                    summary=f"Failed to write {raw_path}",
                    error=error_message,
                    raw_payload={"path": raw_path, "error_kind": error_kind},
                )
            payload = write_file(str(target), content)
        except (OSError, UnicodeDecodeError, ValueError) as exc:
            return ToolResult(
                success=False,
                summary=f"Failed to write {raw_path}",
                error=str(exc),
                raw_payload={"path": raw_path, "error_kind": _write_error_kind(exc)},
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


def _write_error_kind(exc: Exception) -> str:
    if isinstance(exc, UnicodeDecodeError):
        return "invalid_encoding"
    message = str(exc).lower()
    if "workspace" in message:
        return "workspace_escape"
    if "directory" in message:
        return "is_directory"
    return "write_failed"
