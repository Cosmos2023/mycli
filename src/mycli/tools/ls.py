from __future__ import annotations

from pathlib import Path
from typing import Any

from mycli.domain.tooling.calls import ToolCall
from mycli.tools.base import ToolEffectProfile, ToolParameter, ToolResult, ToolSpec
from mycli.tools.path_utils import resolve_workspace_path


class LSError(Exception):
    """Raised when a directory listing request is invalid."""


def ls(path: str) -> dict[str, Any]:
    original = Path(path)
    if not original.is_absolute():
        raise LSError(f"Absolute path required. Got: {path}")

    resolved = original.resolve()
    if not resolved.is_dir():
        raise LSError(f"Not a directory: {path}")

    entries = sorted(
        resolved.iterdir(),
        key=lambda entry: entry.stat().st_mtime,
        reverse=True,
    )

    dirs: list[str] = []
    files: list[str] = []
    hidden: list[str] = []

    for entry in entries:
        if entry.name.startswith("."):
            hidden.append(entry.name)
        elif entry.is_dir():
            dirs.append(entry.name)
        elif entry.is_file():
            files.append(entry.name)

    return {"dirs": dirs, "files": files, "hidden": hidden, "total": len(entries)}


class LSTool:
    name = "LS"
    spec = ToolSpec(
        name="LS",
        description="List a directory non-recursively. Hidden entries are reported separately.",
        parameters=(ToolParameter(name="path", type="string", required=True),),
        risk_level="low",
    )

    def __init__(self, workspace_root: Path) -> None:
        self._workspace_root = workspace_root

    def effect_profile(self) -> ToolEffectProfile:
        return ToolEffectProfile(filesystem="read")

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        raw_path = str(arguments.get("path") or "")
        try:
            if not raw_path:
                raise LSError("LS requires path.")
            target = resolve_workspace_path(self._workspace_root, raw_path)
            payload = ls(str(target))
        except (OSError, ValueError, LSError) as exc:
            return ToolResult(
                success=False,
                summary="Failed to list directory",
                error=str(exc),
                raw_payload={"path": raw_path},
            )

        entries = [*payload["dirs"], *payload["files"], *payload.get("hidden", [])]
        return ToolResult(
            success=True,
            summary=", ".join(entries),
            raw_payload={"path": raw_path, "entries": entries, **payload},
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)
