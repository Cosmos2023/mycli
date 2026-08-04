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
    assert root_package["workspaces"] == ["apps/*", "packages/*", "tui/*"]
    assert root_package["engines"]["node"] == ">=22.19.0"
    assert root_package["scripts"] == {
        "build": (
            "npm run build --workspace @mycli/contracts && "
            "npm run build --workspace @mycli/core && "
            "npm run build --workspace @mycli/config && "
            "npm run build --workspace @mycli/providers && "
            "npm run build --workspace @mycli/storage && "
            "npm run build --workspace @mycli/runtime && "
            "npm run build --workspace mycli-shell-tui && "
            "npm run build --workspace @mycli/app"
        ),
        "contracts:generate": "npm run generate --workspace @mycli/contracts",
        "contracts:check": "npm run check --workspace @mycli/contracts",
        "dev": "node --import tsx apps/mycli/src/cli.ts",
        "lint": 'eslint "apps/**/*.ts" "packages/**/*.ts"',
        "mycli": "node --import tsx apps/mycli/src/cli.ts",
        "pretest": "npm run build",
        "smoke:package": "node scripts/smoke_packed_cli.mjs",
        "test": "npm run test --workspaces --if-present",
        "test:m2": (
            "npm run build && node --import tsx --test "
            "apps/mycli/test/node-backend.integration.test.ts "
            "apps/mycli/test/m2-smoke-runner.integration.test.ts && "
            "uv run pytest tests/integration/test_node_runtime_m2_parity.py -q"
        ),
        "typecheck": "npm run typecheck --workspaces --if-present",
    }
    assert Path("package-lock.json").is_file()
    assert not Path("tui/mycli-shell/package-lock.json").exists()
