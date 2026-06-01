from __future__ import annotations

import difflib
import re
from pathlib import Path

from mycli.tools.file_snapshot import build_file_snapshot

MAX_WRITE_CONTENT_BYTES = 1_000_000
SECRET_PATTERNS = (
    re.compile(r"sk-[A-Za-z0-9_-]{12,}"),
    re.compile(r"(?i)(api[_-]?key|secret|token|password)\s*=\s*['\"][^'\"]{8,}['\"]"),
)


def unified_diff(
    *,
    before: str,
    after: str,
    fromfile: str,
    tofile: str,
) -> str:
    return "\n".join(
        difflib.unified_diff(
            before.splitlines(),
            after.splitlines(),
            fromfile=fromfile,
            tofile=tofile,
            lineterm="",
        )
    )


def backup_file(path: Path, content: str) -> None:
    backup_dir = path.parent / ".mycli_backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"{path.name}.bak"
    backup_path.write_text(content, encoding="utf-8")


def contains_secret_like_content(value: str) -> bool:
    return any(pattern.search(value) is not None for pattern in SECRET_PATTERNS)


def looks_binary(path: Path) -> bool:
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


def validate_text_write_target(path: Path) -> tuple[bool, str | None, str | None]:
    if path.exists() and path.is_dir():
        return False, "is_directory", f"Path is a directory: {path}"
    if path.exists() and looks_binary(path):
        return False, "binary_file", f"Refusing to modify binary-looking file: {path}"
    return True, None, None


def validate_content_safety(content: str) -> tuple[bool, str | None, str | None]:
    encoded_size = len(content.encode("utf-8"))
    if encoded_size > MAX_WRITE_CONTENT_BYTES:
        return False, "content_too_large", f"Content is too large to write safely ({encoded_size} bytes)."
    if contains_secret_like_content(content):
        return False, "secret_like_content", "New content looks like a secret. Refusing to write it."
    return True, None, None


def validate_expected_sha256(
    *,
    workspace_root: Path,
    target: Path,
    expected_sha256: object,
) -> tuple[bool, str | None, str | None]:
    if not isinstance(expected_sha256, str) or not expected_sha256:
        return True, None, None
    if not target.exists():
        return (
            False,
            "stale_write_snapshot",
            "File no longer exists. Re-read or clear expected_sha256 before writing.",
        )
    current = build_file_snapshot(workspace_root=workspace_root, path=target)
    if current.sha256 != expected_sha256:
        return (
            False,
            "stale_write_snapshot",
            "File changed since expected_sha256 was captured. Re-read the file and retry.",
        )
    return True, None, None
