from __future__ import annotations

import json
from pathlib import Path


def test_node_tui_typecheck_script_is_cross_platform() -> None:
    package_path = Path("tui/mycli-shell/package.json")
    package = json.loads(package_path.read_text(encoding="utf-8"))

    assert package["scripts"]["typecheck"] == "tsc --noEmit"


def test_node_tui_tsx_scripts_support_hoisted_workspace_dependencies() -> None:
    package_path = Path("tui/mycli-shell/package.json")
    package = json.loads(package_path.read_text(encoding="utf-8"))

    assert package["scripts"]["demo"] == "node --import tsx src/demo.ts"
    assert package["scripts"]["test"] == (
        'node --import tsx --test "test/**/*.test.ts" --test-reporter=dot'
    )


def test_root_node_workspace_owns_install_and_quality_scripts() -> None:
    root_package = json.loads(Path("package.json").read_text(encoding="utf-8"))

    assert root_package["private"] is True
    assert root_package["type"] == "module"
    assert root_package["workspaces"] == ["packages/*", "tui/*"]
    assert root_package["engines"]["node"] == ">=22.19.0"
    assert root_package["scripts"] == {
        "contracts:generate": "npm run generate --workspace @mycli/contracts",
        "contracts:check": "npm run check --workspace @mycli/contracts",
        "lint": 'eslint "packages/**/*.ts"',
        "test": "npm run test --workspaces --if-present",
        "typecheck": "npm run typecheck --workspaces --if-present",
    }
    assert Path("package-lock.json").is_file()
    assert not Path("tui/mycli-shell/package-lock.json").exists()
