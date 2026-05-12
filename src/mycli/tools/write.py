from __future__ import annotations

from pathlib import Path
from typing import Any


def write_file(file_path: str, content: str) -> dict[str, Any]:
    path = Path(file_path)
    path.parent.mkdir(parents=True, exist_ok=True)

    existed = path.exists()
    if existed:
        if path.is_dir():
            return {"error": f"[Path is a directory: {file_path}]"}
        existing = path.read_text()
        if existing == content:
            return {"status": "unchanged", "file": str(path)}
        _backup(path, existing)

    path.write_text(content)
    return {"status": "overwritten" if existed else "created", "file": str(path)}


def _backup(path: Path, content: str) -> None:
    backup_dir = path.parent / ".mycli_backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"{path.name}.bak"
    backup_path.write_text(content)
