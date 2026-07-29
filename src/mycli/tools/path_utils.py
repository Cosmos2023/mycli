from __future__ import annotations

from pathlib import Path


def resolve_workspace_path(
    workspace_root: Path,
    raw_path: str,
    *,
    allowed_roots: tuple[Path, ...] = (),
    unrestricted: bool = False,
) -> Path:
    raw_candidate = Path(raw_path)
    candidate = (
        raw_candidate if raw_candidate.is_absolute() else workspace_root / raw_candidate
    ).resolve()
    if unrestricted:
        return candidate
    roots = (workspace_root, *allowed_roots)
    if not any(_is_within(candidate, root) for root in roots):
        raise ValueError("Path must stay within the current workspace or allowed roots.")
    return candidate


def _is_within(candidate: Path, root: Path) -> bool:
    resolved_root = root.resolve()
    return candidate == resolved_root or resolved_root in candidate.parents


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
    if "does not exist" in message or "not found" in message:
        return "not_found"
    return "invalid_path"
