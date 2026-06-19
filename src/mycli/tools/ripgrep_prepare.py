from __future__ import annotations

from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import shutil
import stat
import sys
import tarfile
import tempfile
from urllib.request import urlopen
import zipfile


RIPGREP_VERSION = "15.1.0"
RIPGREP_TARGETS = {
    "macos-aarch64": {
        "archive": "ripgrep-15.1.0-aarch64-apple-darwin.tar.gz",
        "path": "ripgrep-15.1.0-aarch64-apple-darwin/rg",
        "sha256": "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
    },
    "macos-x86_64": {
        "archive": "ripgrep-15.1.0-x86_64-apple-darwin.tar.gz",
        "path": "ripgrep-15.1.0-x86_64-apple-darwin/rg",
        "sha256": "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
    },
    "linux-aarch64": {
        "archive": "ripgrep-15.1.0-aarch64-unknown-linux-gnu.tar.gz",
        "path": "ripgrep-15.1.0-aarch64-unknown-linux-gnu/rg",
        "sha256": "2b661c6ef508e902f388e9098d9c4c5aca72c87b55922d94abdba830b4dc885e",
    },
    "linux-x86_64": {
        "archive": "ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz",
        "path": "ripgrep-15.1.0-x86_64-unknown-linux-musl/rg",
        "sha256": "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
    },
    "windows-aarch64": {
        "archive": "ripgrep-15.1.0-aarch64-pc-windows-msvc.zip",
        "path": "ripgrep-15.1.0-aarch64-pc-windows-msvc/rg.exe",
        "sha256": "00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e",
    },
    "windows-x86_64": {
        "archive": "ripgrep-15.1.0-x86_64-pc-windows-msvc.zip",
        "path": "ripgrep-15.1.0-x86_64-pc-windows-msvc/rg.exe",
        "sha256": "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
    },
}


@dataclass(slots=True, frozen=True)
class RipgrepPrepareResult:
    path: Path
    installed: bool


def prepare_user_ripgrep(
    *,
    target: str | None = None,
    dest_root: Path | None = None,
    force: bool = False,
) -> RipgrepPrepareResult:
    resolved_target = target or platform_key()
    if resolved_target not in RIPGREP_TARGETS:
        raise ValueError(f"unsupported target: {resolved_target}")
    target_info = RIPGREP_TARGETS[resolved_target]
    output_path = ripgrep_output_path(
        target=resolved_target,
        dest_root=dest_root or default_user_ripgrep_root(),
    )
    if output_path.exists() and not force:
        return RipgrepPrepareResult(path=output_path, installed=False)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    archive_name = str(target_info["archive"])
    url = f"https://github.com/BurntSushi/ripgrep/releases/download/{RIPGREP_VERSION}/{archive_name}"
    with tempfile.TemporaryDirectory(prefix="mycli-rg-") as temp_dir:
        archive_path = Path(temp_dir) / archive_name
        download(url, archive_path)
        verify_sha256(archive_path, str(target_info["sha256"]))
        extracted = extract_member(archive_path, str(target_info["path"]), Path(temp_dir))
        shutil.copy2(extracted, output_path)
    output_path.chmod(output_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return RipgrepPrepareResult(path=output_path, installed=True)


def ripgrep_output_path(*, target: str, dest_root: Path) -> Path:
    binary_name = "rg.exe" if target.startswith("windows-") else "rg"
    return dest_root / target / binary_name


def default_user_ripgrep_root() -> Path:
    return Path.home() / ".mycli" / "vendor" / "ripgrep"


def platform_key() -> str:
    if os.name == "nt":
        platform = "windows"
    elif sys.platform == "darwin":
        platform = "macos"
    elif sys.platform.startswith("linux"):
        platform = "linux"
    else:
        raise ValueError(f"unsupported platform: {sys.platform}")
    machine = os.uname().machine.lower() if hasattr(os, "uname") else "unknown"
    if machine in {"amd64", "x86_64"}:
        arch = "x86_64"
    elif machine in {"arm64", "aarch64"}:
        arch = "aarch64"
    else:
        raise ValueError(f"unsupported architecture: {machine}")
    key = f"{platform}-{arch}"
    if key not in RIPGREP_TARGETS:
        raise ValueError(f"unsupported target: {key}")
    return key


def download(url: str, dest: Path) -> None:
    with urlopen(url, timeout=60) as response:
        dest.write_bytes(response.read())


def verify_sha256(path: Path, expected: str) -> None:
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != expected:
        raise ValueError(f"sha256 mismatch for {path.name}: expected {expected}, got {actual}")


def extract_member(archive_path: Path, member_path: str, temp_dir: Path) -> Path:
    if archive_path.suffix == ".zip":
        with zipfile.ZipFile(archive_path) as archive:
            archive.extract(member_path, temp_dir)
    else:
        with tarfile.open(archive_path) as archive:
            archive.extract(member_path, temp_dir, filter="data")
    return temp_dir / member_path
