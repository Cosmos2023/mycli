from __future__ import annotations

import os
from pathlib import Path
from typing import Any


MAX_RESULTS = 200


def glob(pattern: str, path: str | None = None) -> dict[str, Any]:
    root = Path(path or os.getcwd()).resolve()
    matches = sorted(
        root.glob(pattern),
        key=lambda match: match.stat().st_mtime,
        reverse=True,
    )

    truncated = len(matches) > MAX_RESULTS
    shown_matches = matches[:MAX_RESULTS] if truncated else matches

    files: list[str] = []
    dirs: list[str] = []
    for match in shown_matches:
        relative = str(match.relative_to(root))
        if match.is_file():
            files.append(relative)
        elif match.is_dir():
            dirs.append(relative)

    return {
        "files": files,
        "dirs": dirs,
        "count": len(shown_matches),
        "truncated": truncated,
    }
