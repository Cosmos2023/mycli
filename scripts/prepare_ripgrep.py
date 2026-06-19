#!/usr/bin/env python3
from __future__ import annotations

import argparse
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


VERSION = "15.1.0"
TARGETS = {
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare a vendored ripgrep binary for mycli.")
    parser.add_argument("--target", choices=sorted(TARGETS), default=platform_key())
    parser.add_argument(
        "--dest",
        type=Path,
        default=None,
        help="Root directory where <target>/rg will be installed.",
    )
    parser.add_argument(
        "--package",
        action="store_true",
        help="Install into src/mycli/vendor/ripgrep for release builds.",
    )
    parser.add_argument("--force", action="store_true", help="Overwrite an existing rg binary.")
    args = parser.parse_args()

    target = args.target
    target_info = TARGETS[target]
    binary_name = "rg.exe" if target.startswith("windows-") else "rg"
    dest_root = resolve_dest(args.dest, package=args.package)
    target_dir = dest_root / target
    output_path = target_dir / binary_name
    if output_path.exists() and not args.force:
        print(f"ripgrep already prepared: {output_path}")
        return 0

    target_dir.mkdir(parents=True, exist_ok=True)
    archive_name = str(target_info["archive"])
    url = f"https://github.com/BurntSushi/ripgrep/releases/download/{VERSION}/{archive_name}"
    with tempfile.TemporaryDirectory(prefix="mycli-rg-") as temp_dir:
        archive_path = Path(temp_dir) / archive_name
        download(url, archive_path)
        verify_sha256(archive_path, str(target_info["sha256"]))
        extracted = extract_member(archive_path, str(target_info["path"]), Path(temp_dir))
        shutil.copy2(extracted, output_path)
    output_path.chmod(output_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    print(f"prepared ripgrep {VERSION}: {output_path}")
    return 0


def resolve_dest(dest: Path | None, *, package: bool) -> Path:
    if dest is not None:
        return dest
    if package:
        return Path(__file__).resolve().parents[1] / "src" / "mycli" / "vendor" / "ripgrep"
    return Path.home() / ".mycli" / "vendor" / "ripgrep"


def platform_key() -> str:
    if os.name == "nt":
        platform = "windows"
    elif sys.platform == "darwin":
        platform = "macos"
    elif sys.platform.startswith("linux"):
        platform = "linux"
    else:
        raise SystemExit(f"unsupported platform: {sys.platform}")
    machine = os.uname().machine.lower() if hasattr(os, "uname") else "unknown"
    if machine in {"amd64", "x86_64"}:
        arch = "x86_64"
    elif machine in {"arm64", "aarch64"}:
        arch = "aarch64"
    else:
        raise SystemExit(f"unsupported architecture: {machine}")
    key = f"{platform}-{arch}"
    if key not in TARGETS:
        raise SystemExit(f"unsupported target: {key}")
    return key


def download(url: str, dest: Path) -> None:
    with urlopen(url, timeout=60) as response:
        dest.write_bytes(response.read())


def verify_sha256(path: Path, expected: str) -> None:
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f"sha256 mismatch for {path.name}: expected {expected}, got {actual}")


def extract_member(archive_path: Path, member_path: str, temp_dir: Path) -> Path:
    if archive_path.suffix == ".zip":
        with zipfile.ZipFile(archive_path) as archive:
            archive.extract(member_path, temp_dir)
    else:
        with tarfile.open(archive_path) as archive:
            archive.extract(member_path, temp_dir, filter="data")
    return temp_dir / member_path


if __name__ == "__main__":
    raise SystemExit(main())
