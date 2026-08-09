from __future__ import annotations

from pathlib import Path

from mycli.prompts.system import SYSTEM_PROMPT_VERSION, build_system_prompt


def test_node_system_prompt_source_matches_python_template() -> None:
    root = Path(__file__).resolve().parents[3]
    node_source = root / "backend/apps/mycli/src/node-runtime/system-prompt.ts"
    copy_script = root / "backend/apps/mycli/scripts/copy-system-prompt.mjs"

    assert build_system_prompt() == (
        root / "src/mycli/prompts/templates/system.md"
    ).read_text(encoding="utf-8").strip()
    assert SYSTEM_PROMPT_VERSION in node_source.read_text(encoding="utf-8")
    assert "src/mycli/prompts/templates/system.md" in copy_script.read_text(encoding="utf-8")
