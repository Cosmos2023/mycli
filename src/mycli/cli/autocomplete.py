from __future__ import annotations

from pathlib import Path


def path_completion_candidates(workspace_root: Path, token: str) -> tuple[str, ...]:
    if not token.startswith("@"):
        return ()
    raw = token[1:]
    if raw.startswith("../") or raw == "..":
        return ()
    root = workspace_root.resolve()
    base = root / raw
    if raw.endswith("/"):
        parent = base
        prefix = ""
    else:
        parent = base.parent if raw else root
        prefix = base.name if raw else ""
    try:
        resolved_parent = parent.resolve()
    except OSError:
        return ()
    if not _is_relative_to(resolved_parent, root) or not resolved_parent.is_dir():
        return ()
    candidates: list[str] = []
    for child in sorted(resolved_parent.iterdir(), key=lambda path: path.name):
        if prefix and not child.name.startswith(prefix):
            continue
        try:
            resolved_child = child.resolve()
        except OSError:
            continue
        if not _is_relative_to(resolved_child, root):
            continue
        rel = child.relative_to(root).as_posix()
        suffix = "/" if child.is_dir() else ""
        candidates.append(f"@{rel}{suffix}")
    return tuple(candidates)


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False
