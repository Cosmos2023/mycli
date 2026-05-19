from __future__ import annotations

import importlib
from pathlib import Path
from types import ModuleType
from typing import Any, Callable, cast

from mycli.domain.tooling.calls import ToolCall, ToolEvidence
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec
from mycli.tools.file_snapshot import (
    FileSnapshot,
    FileSnapshotStore,
    build_file_snapshot,
)
from mycli.tools.path_utils import classify_filesystem_error, resolve_workspace_path


TEXT_EXTENSIONS = {
    ".bash",
    ".c",
    ".cfg",
    ".conf",
    ".cpp",
    ".css",
    ".env",
    ".go",
    ".h",
    ".html",
    ".ini",
    ".java",
    ".js",
    ".json",
    ".kt",
    ".log",
    ".lua",
    ".markdown",
    ".md",
    ".mdx",
    ".php",
    ".py",
    ".r",
    ".rb",
    ".rs",
    ".rst",
    ".scala",
    ".sh",
    ".sql",
    ".swift",
    ".tex",
    ".toml",
    ".ts",
    ".txt",
    ".xml",
    ".yaml",
    ".zig",
    ".zsh",
}

HANDLER_MAP = {
    ".csv": "mycli.tools.read.csv_handler",
    ".tsv": "mycli.tools.read.csv_handler",
    ".xlsx": "mycli.tools.read.excel_handler",
    ".xls": "mycli.tools.read.excel_handler",
    ".pdf": "mycli.tools.read.pdf_handler",
    ".docx": "mycli.tools.read.docx_handler",
    ".ipynb": "mycli.tools.read.ipynb_handler",
}

LAZY_IMPORTS: dict[str, ModuleType] = {}


def read_file(
    file_path: str,
    offset: int = 1,
    limit: int = 2000,
    pages: str | None = None,
) -> dict[str, Any]:
    path = Path(file_path)
    if not path.exists():
        return {"error": f"[File not found: {file_path}]"}
    if path.is_dir():
        return {"error": f"[Path is a directory: {file_path}. Use LS to browse.]"}

    ext = path.suffix.lower()
    if ext in TEXT_EXTENSIONS or ext == "":
        return _read_text(file_path, offset=offset, limit=limit)

    handler_mod = _get_handler(ext)
    if handler_mod is not None:
        try:
            handler = cast(
                Callable[..., dict[str, Any]], getattr(handler_mod, "read_file")
            )
            return handler(file_path, pages=pages)
        except ImportError:
            return {
                "error": (
                    f"[{ext} support not installed. "
                    "Install required dependency to read this file type.]"
                ),
            }

    if _looks_binary(path):
        return {
            "error": (
                f"[Cannot read binary file: {file_path}. "
                "Detected as non-text format.]"
            ),
        }

    try:
        return _read_text(file_path, offset=offset, limit=limit)
    except UnicodeDecodeError:
        return {
            "error": (
                f"[Cannot read binary file: {file_path}. "
                "Detected as non-text format.]"
            ),
        }


def _get_handler(ext: str) -> ModuleType | None:
    module_path = HANDLER_MAP.get(ext)
    if module_path is None:
        return None
    if module_path not in LAZY_IMPORTS:
        LAZY_IMPORTS[module_path] = importlib.import_module(module_path)
    return LAZY_IMPORTS[module_path]


def _looks_binary(path: Path) -> bool:
    sample = path.read_bytes()[:1024]
    if b"\x00" in sample:
        return True
    if not sample:
        return False
    text_controls = {7, 8, 9, 10, 12, 13, 27}
    suspicious = sum(
        1 for byte in sample if byte < 32 and byte not in text_controls
    )
    return suspicious / len(sample) > 0.30


def _read_text(file_path: str, offset: int, limit: int) -> dict[str, Any]:
    from mycli.tools.read.text import read_text

    return read_text(file_path, offset=offset, limit=limit)


class ReadTool:
    name = "Read"
    spec = ToolSpec(
        name="Read",
        description="Read a file from the workspace. Supports text, CSV/TSV, and optional structured handlers. Use offset/limit for specific line ranges.",
        parameters=(
            ToolParameter(name="file_path", type="string", required=True),
            ToolParameter(name="offset", type="integer", required=False),
            ToolParameter(name="limit", type="integer", required=False),
            ToolParameter(name="pages", type="string", required=False),
        ),
        risk_level="low",
    )

    def __init__(
        self, workspace_root: Path, snapshot_store: FileSnapshotStore | None = None
    ) -> None:
        self._workspace_root = workspace_root
        self._snapshot_store = snapshot_store or FileSnapshotStore()

    def execute(self, arguments: dict[str, Any]) -> ToolResult:
        raw_path = str(arguments.get("file_path") or arguments.get("path") or "")
        try:
            if not raw_path:
                raise ValueError("Read requires file_path.")
            target = resolve_workspace_path(self._workspace_root, raw_path)
            offset = int(arguments.get("offset", arguments.get("start_line", 1)))
            if "end_line" in arguments and "limit" not in arguments:
                end_line = int(arguments["end_line"])
                limit = max(0, end_line - offset + 1)
            else:
                limit = int(arguments.get("limit", 2000))
            payload = read_file(
                str(target),
                offset=offset,
                limit=limit,
                pages=cast(str | None, arguments.get("pages")),
            )
        except (OSError, UnicodeDecodeError, ValueError) as exc:
            return ToolResult(
                success=False,
                summary=f"Failed to read {raw_path}",
                error=str(exc),
                raw_payload={"path": raw_path, "error_kind": classify_filesystem_error(exc)},
            )

        if "error" in payload:
            error = str(payload["error"])
            error_kind = "not_found" if "not found" in error.lower() else "invalid_path"
            return ToolResult(
                success=False,
                summary=f"Failed to read {raw_path}",
                error=error,
                raw_payload={"path": raw_path, "error_kind": error_kind, **payload},
            )

        snapshot = _snapshot_from_read_payload(
            workspace_root=self._workspace_root,
            target=target,
            payload=payload,
        )
        if snapshot is None:
            try:
                snapshot = build_file_snapshot(workspace_root=self._workspace_root, path=target)
            except OSError:
                snapshot = None
        if snapshot is not None:
            self._snapshot_store.record(snapshot)
            payload["snapshot"] = snapshot.to_dict()

        evidence: tuple[ToolEvidence, ...] = ()
        content = payload.get("content")
        if isinstance(content, str) and content:
            shown_lines = payload.get("shown_lines")
            line_count = (
                int(shown_lines)
                if isinstance(shown_lines, int)
                else len(content.splitlines())
            )
            line_end = max(offset, offset + line_count - 1)
            evidence = (
                ToolEvidence(
                    kind="file_excerpt",
                    title=f"Excerpt from {raw_path}",
                    path=raw_path,
                    line_start=offset,
                    line_end=line_end,
                    snippet=_strip_read_line_numbers(content),
                ),
            )
        return ToolResult(
            success=True,
            summary=f"Read {raw_path}",
            raw_payload={"path": raw_path, **payload},
            evidence=evidence,
        )

    def run(self, call: ToolCall) -> ToolResult:
        return self.execute(call.arguments)


def _strip_read_line_numbers(content: str) -> str:
    lines: list[str] = []
    for line in content.splitlines():
        _, separator, text = line.partition("\t")
        lines.append(text if separator else line)
    return "\n".join(lines)


def _snapshot_from_read_payload(
    *,
    workspace_root: Path,
    target: Path,
    payload: dict[str, Any],
) -> FileSnapshot | None:
    raw_sha = payload.get("sha256")
    raw_mtime = payload.get("mtime_ns")
    raw_size = payload.get("size")
    if not isinstance(raw_sha, str) or not raw_sha:
        return None
    if isinstance(raw_mtime, bool) or not isinstance(raw_mtime, int):
        return None
    if isinstance(raw_size, bool) or not isinstance(raw_size, int):
        return None
    root = workspace_root.resolve()
    resolved = target.resolve()
    if resolved != root and root not in resolved.parents:
        return None
    return FileSnapshot(
        path=resolved.relative_to(root).as_posix(),
        sha256=raw_sha,
        mtime_ns=raw_mtime,
        size=raw_size,
        captured_at=str(payload.get("captured_at") or ""),
    )
