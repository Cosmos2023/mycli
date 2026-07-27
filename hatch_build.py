from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType
from typing import Any, Callable, cast

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


def _load_build_utils() -> ModuleType:
    path = Path(__file__).with_name("hatch_build_utils.py")
    spec = importlib.util.spec_from_file_location("mycli_hatch_build_utils", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load build utilities: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


windows_wheel_platform = cast(
    Callable[[Path], str],
    _load_build_utils().windows_wheel_platform,
)


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        del version
        helper = Path(self.root) / "src" / "mycli" / "native" / "windows" / (
            "mycli-windows-sandbox.exe"
        )
        if not helper.is_file():
            return

        wheel_platform = windows_wheel_platform(helper)
        build_data["tag"] = f"py3-none-{wheel_platform}"
        build_data["pure_python"] = False
