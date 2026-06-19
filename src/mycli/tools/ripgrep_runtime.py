from __future__ import annotations

import os
from pathlib import Path
import shutil
import sys

RIPGREP_VERSION = "15.1.0"
RIPGREP_BINARY_NAME = "rg.exe" if os.name == "nt" else "rg"


def prepend_ripgrep_to_path(path_value: str | None) -> tuple[str, str | None]:
    """Return PATH with mycli's prepared rg directory first when available."""

    rg_path = prepared_ripgrep_path()
    if rg_path is None:
        return path_value or os.defpath, None
    path_dir = str(rg_path.parent)
    existing = path_value or os.defpath
    parts = [part for part in existing.split(os.pathsep) if part]
    filtered = [part for part in parts if Path(part) != rg_path.parent]
    return os.pathsep.join([path_dir, *filtered]), path_dir


def prepared_ripgrep_path() -> Path | None:
    for candidate in ripgrep_candidates():
        if _is_executable(candidate):
            return candidate
    discovered = shutil.which("rg")
    if discovered:
        return Path(discovered)
    return None


def ripgrep_candidates() -> tuple[Path, ...]:
    return (
        _package_vendor_root() / RIPGREP_BINARY_NAME,
        _user_vendor_root() / RIPGREP_BINARY_NAME,
    )


def _package_vendor_root() -> Path:
    return Path(__file__).resolve().parents[1] / "vendor" / "ripgrep" / _platform_key()


def _user_vendor_root() -> Path:
    return Path.home() / ".mycli" / "vendor" / "ripgrep" / _platform_key()


def _platform_key() -> str:
    if os.name == "nt":
        platform = "windows"
    elif sys.platform == "darwin":
        platform = "macos"
    elif sys.platform.startswith("linux"):
        platform = "linux"
    else:
        platform = sys.platform
    machine = os.uname().machine.lower() if hasattr(os, "uname") else "unknown"
    if machine in {"amd64", "x86_64"}:
        arch = "x86_64"
    elif machine in {"arm64", "aarch64"}:
        arch = "aarch64"
    else:
        arch = machine
    return f"{platform}-{arch}"


def _is_executable(path: Path) -> bool:
    return path.is_file() and os.access(path, os.X_OK)
