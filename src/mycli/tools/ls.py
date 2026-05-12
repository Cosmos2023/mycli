from __future__ import annotations

from pathlib import Path
from typing import Any


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
