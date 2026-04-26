from __future__ import annotations

from pathlib import Path


def resolve_workspace_path(workspace_root: Path, raw_path: str) -> Path:
    candidate = (workspace_root / raw_path).resolve()
    root = workspace_root.resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError("Path must stay within the current workspace.")
    return candidate


def require_text_file(path: Path) -> None:
    if path.exists() and path.is_dir():
        raise ValueError("Expected a file path, got a directory.")


def classify_filesystem_error(exc: Exception) -> str:
    if isinstance(exc, FileNotFoundError):
        return "not_found"
    if isinstance(exc, PermissionError):
        return "permission_denied"
    if isinstance(exc, UnicodeDecodeError):
        return "invalid_encoding"
    message = str(exc).lower()
    if "workspace" in message:
        return "workspace_escape"
    if "expected a directory" in message:
        return "not_directory"
    if "expected a file path" in message:
        return "is_directory"
    if "line range" in message:
        return "invalid_range"
    return "invalid_path"
