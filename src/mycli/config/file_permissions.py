from __future__ import annotations

from collections.abc import Callable
import os
from pathlib import Path


Chmod = Callable[[Path, int], None]


def harden_private_path(
    path: Path,
    *,
    mode: int,
    os_name: str = os.name,
    chmod: Chmod = lambda target, value: target.chmod(value),
) -> None:
    try:
        chmod(path, mode)
    except OSError:
        if os_name != "nt":
            raise
