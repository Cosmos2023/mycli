from __future__ import annotations

from pathlib import Path
import platform
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        del version
        helper = Path(self.root) / "src" / "mycli" / "native" / "windows" / (
            "mycli-windows-sandbox.exe"
        )
        if not helper.is_file():
            return

        architecture = platform.machine().lower()
        if architecture in {"amd64", "x86_64"}:
            wheel_platform = "win_amd64"
        elif architecture in {"arm64", "aarch64"}:
            wheel_platform = "win_arm64"
        elif architecture in {"x86", "i386", "i686"}:
            wheel_platform = "win32"
        else:
            raise RuntimeError(f"Unsupported Windows helper architecture: {architecture}")

        build_data["tag"] = f"py3-none-{wheel_platform}"
        build_data["pure_python"] = False
