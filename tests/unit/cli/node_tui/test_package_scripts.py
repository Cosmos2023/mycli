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
            "npm run build --workspace @mycli/tools && "
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
        "smoke:m3": "node scripts/smoke_node_m3_read.mjs --protocol responses",
        "smoke:m4": "node scripts/smoke_node_m4_mutation.mjs --protocol responses",
        "smoke:m5": "node scripts/smoke_node_m5_state.mjs --protocol responses",
        "smoke:m6": "node scripts/smoke_node_m6_shell.mjs --protocol responses",
        "test": "npm run test --workspaces --if-present",
        "test:m2": (
            "npm run build && node --import tsx --test "
            "apps/mycli/test/node-backend.integration.test.ts "
            "apps/mycli/test/m2-smoke-runner.integration.test.ts && "
            "uv run pytest tests/integration/test_node_runtime_m2_parity.py -q"
        ),
        "test:m3": (
            "npm run build && node --import tsx --test "
            "apps/mycli/test/m3-read-turn.integration.test.ts && "
            "uv run pytest tests/integration/test_node_runtime_m3_parity.py -q"
        ),
        "test:m4": (
            "npm run build && node --import tsx --test "
            "apps/mycli/test/m4-file-mutation.integration.test.ts && "
            "uv run pytest tests/integration/test_node_runtime_m4_parity.py -q"
        ),
        "test:m5": (
            "npm run build && node --import tsx --test "
            "apps/mycli/test/m5-state-recovery.integration.test.ts && "
            "uv run pytest tests/integration/test_node_runtime_m5_parity.py -q"
        ),
        "test:m6": (
            "npm run build && node --import tsx --test "
            "apps/mycli/test/m6-persistent-shell.integration.test.ts && "
            "uv run pytest tests/integration/test_node_runtime_m6_parity.py -q"
        ),
        "typecheck": "npm run typecheck --workspaces --if-present",
    }
    assert Path("package-lock.json").is_file()
    assert not Path("tui/mycli-shell/package-lock.json").exists()


def test_node_app_exposes_the_targeted_m5_integration_script() -> None:
    app_package = json.loads(Path("apps/mycli/package.json").read_text(encoding="utf-8"))

    assert app_package["scripts"]["test:m5"] == (
        "node --import tsx --test test/m5-state-recovery.integration.test.ts"
    )


def test_node_app_exposes_the_targeted_m6_integration_script() -> None:
    app_package = json.loads(Path("apps/mycli/package.json").read_text(encoding="utf-8"))

    assert app_package["scripts"]["test:m6"] == (
        "node --import tsx --test test/m6-persistent-shell.integration.test.ts"
    )
