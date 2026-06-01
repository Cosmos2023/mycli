from __future__ import annotations

from pathlib import Path
from typing import Any

from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec
from mycli.tools.edit import EditTool, edit_file
from mycli.tools.file_snapshot import FileSnapshotStore
from mycli.tools.file_mutation import validate_content_safety, validate_text_write_target
from mycli.tools.path_utils import resolve_workspace_path


class PatchTool:
    name = "Patch"
    spec = ToolSpec(
        name="Patch",
        description=(
            "Apply an exact replacement patch to a recently read file. "
            "Use when changing part of a file and include enough context for old_string to be unique."
        ),
        parameters=(
            ToolParameter(name="file_path", type="string", required=True),
            ToolParameter(name="old_string", type="string", required=True),
            ToolParameter(name="new_string", type="string", required=True),
            ToolParameter(name="replace_all", type="boolean", required=False),
        ),
        risk_level="medium",
    )

    def __init__(
        self,
        workspace_root: Path,
        snapshot_store: FileSnapshotStore | None = None,
    ) -> None:
        self._workspace_root = workspace_root
        self._snapshot_store = snapshot_store or FileSnapshotStore()
        self._edit_guard = EditTool(workspace_root, snapshot_store=self._snapshot_store)

    def mutation_targets(self, arguments: dict[str, Any]) -> tuple[str, ...]:
        return self._edit_guard.mutation_targets(arguments)

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        raw_path = str(arguments.get("file_path") or arguments.get("path") or "")
        try:
            if not raw_path:
                raise ValueError("Patch requires file_path.")
            target = resolve_workspace_path(self._workspace_root, raw_path)
            ok, error_kind, error_message = validate_text_write_target(target)
            if not ok:
                return _failed(raw_path=raw_path, error_kind=error_kind, error_message=error_message)
            ok, error_kind, error_message = self._edit_guard._validate_snapshot(target)
            if not ok:
                return _failed(raw_path=raw_path, error_kind=error_kind, error_message=error_message)
            old_string = str(arguments.get("old_string", arguments.get("old_text", "")))
            new_string = str(arguments.get("new_string", arguments.get("new_text", "")))
            ok, error_kind, error_message = validate_content_safety(new_string)
            if not ok:
                return _failed(raw_path=raw_path, error_kind=error_kind, error_message=error_message)
            payload = edit_file(
                str(target),
                old_string,
                new_string,
                replace_all=bool(arguments.get("replace_all", False)),
            )
        except Exception as exc:
            return _failed(
                raw_path=raw_path,
                error_kind=_patch_error_kind(exc),
                error_message=str(exc),
            )
        return ToolResult(
            success=True,
            summary=f"Patched {raw_path}",
            raw_payload={"path": raw_path, **payload, "status": "patched"},
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)


def _failed(
    *,
    raw_path: str,
    error_kind: str | None,
    error_message: str | None,
) -> ToolResult:
    return ToolResult(
        success=False,
        summary=f"Failed to patch {raw_path}",
        error=error_message,
        raw_payload={"path": raw_path, "error_kind": error_kind or "patch_failed"},
    )


def _patch_error_kind(exc: Exception) -> str:
    message = str(exc).lower()
    if "no-op" in message:
        return "no_op"
    if "multiple matches" in message:
        return "multiple_matches"
    if "string not found" in message:
        return "string_not_found"
    if "does not exist" in message:
        return "not_found"
    if "directory" in message:
        return "is_directory"
    if isinstance(exc, UnicodeDecodeError):
        return "invalid_encoding"
    return "patch_failed"
