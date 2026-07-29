from __future__ import annotations

from pathlib import Path
from typing import Any

from mycli.domain.tooling.calls import ToolCall
from mycli.services.filesystem import FileSystemRuntime, FileSystemRuntimeError
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec
from mycli.tools.model_output import mutation_model_output
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
        model_output_adapter=mutation_model_output,
    )

    def __init__(
        self,
        workspace_root: Path,
        filesystem_runtime: FileSystemRuntime | None = None,
    ) -> None:
        self._workspace_root = workspace_root
        self._filesystem = filesystem_runtime or FileSystemRuntime(workspace_root=workspace_root)

    def mutation_targets(self, arguments: dict[str, Any]) -> tuple[str, ...]:
        raw_path = str(arguments.get("file_path") or arguments.get("path") or "")
        if not raw_path:
            raise ValueError("Write requires file_path.")
        content = arguments.get("content", arguments.get("new_content"))
        if not isinstance(content, str):
            raise ValueError("Write requires string content.")
        target = self._filesystem.resolve_path(raw_path)
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
            target = self._filesystem.resolve_path(raw_path)
            validation = self._filesystem.validate_text_target(target)
            ok, error_kind, error_message = (
                validation.ok,
                validation.error_kind,
                validation.error_message,
            )
            if not ok:
                return ToolResult(
                    success=False,
                    summary=f"Failed to write {raw_path}",
                    error=error_message,
                    raw_payload={"path": raw_path, "error_kind": error_kind},
                )
            validation = self._filesystem.validate_content(content)
            ok, error_kind, error_message = (
                validation.ok,
                validation.error_kind,
                validation.error_message,
            )
            if not ok:
                return ToolResult(
                    success=False,
                    summary=f"Failed to write {raw_path}",
                    error=error_message,
                    raw_payload={"path": raw_path, "error_kind": error_kind},
                )
            validation = self._filesystem.validate_expected_sha256(
                target=target,
                expected_sha256=arguments.get("expected_sha256"),
            )
            ok, error_kind, error_message = (
                validation.ok,
                validation.error_kind,
                validation.error_message,
            )
            if not ok:
                return ToolResult(
                    success=False,
                    summary=f"Failed to write {raw_path}",
                    error=error_message,
                    raw_payload={"path": raw_path, "error_kind": error_kind},
                )
            payload = self._filesystem.write_full_content(target=target, content=content)
        except (OSError, UnicodeDecodeError, ValueError, FileSystemRuntimeError) as exc:
            return ToolResult(
                success=False,
                summary=f"Failed to write {raw_path}",
                error=str(exc),
                raw_payload={"path": raw_path, "error_kind": _write_error_kind(exc)},
            )

        return ToolResult(
            success=True,
            summary=f"Wrote {raw_path}",
            raw_payload={
                "path": raw_path,
                "status": payload.status,
                "file": payload.file,
                "diff": payload.diff,
            },
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)


def _write_error_kind(exc: Exception) -> str:
    if isinstance(exc, FileSystemRuntimeError):
        return exc.error_kind
    if isinstance(exc, UnicodeDecodeError):
        return "invalid_encoding"
    message = str(exc).lower()
    if "workspace" in message:
        return "workspace_escape"
    if "directory" in message:
        return "is_directory"
    return "write_failed"
