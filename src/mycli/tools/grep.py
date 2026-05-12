from __future__ import annotations

import os
import subprocess
from typing import Any


EXCLUDE_DIRS = [".git", "node_modules", "__pycache__", ".venv", "dist", "build"]


def grep(
    pattern: str,
    path: str | None = None,
    output_mode: str = "files_with_matches",
    include: str | None = None,
    context: int = 3,
    head_limit: int = 50,
    ignore_case: bool = False,
) -> dict[str, Any]:
    args = ["rg", "--no-heading", "--color", "never", "--with-filename"]

    for directory in EXCLUDE_DIRS:
        args.extend(["--glob", f"!{directory}"])

    if output_mode == "files_with_matches":
        args.append("--files-with-matches")
    elif output_mode == "content":
        args.extend(["-C", str(context)])
    else:
        return {"error": f"[Unsupported grep output_mode: {output_mode}]"}

    if include:
        args.extend(["--glob", include])
    if ignore_case:
        args.append("-i")

    args.extend(["--", pattern])
    if path:
        args.append(path)

    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=30,
            cwd=os.getcwd(),
            check=False,
        )
    except FileNotFoundError:
        return {"error": "[ripgrep (rg) not installed. Install: brew install ripgrep]"}
    except subprocess.TimeoutExpired:
        return {"error": "[Grep timed out. Narrow your search path.]"}

    lines = result.stdout.splitlines()
    truncated = len(lines) > head_limit

    return {
        "matches": lines[:head_limit],
        "count": len(lines),
        "truncated": truncated,
        "mode": output_mode,
    }
