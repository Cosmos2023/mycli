from __future__ import annotations

import json
from pathlib import Path


def test_node_tui_typecheck_script_is_cross_platform() -> None:
    package_path = Path("tui/mycli-shell/package.json")
    package = json.loads(package_path.read_text(encoding="utf-8"))

    assert package["scripts"]["typecheck"] == "tsc --noEmit"
