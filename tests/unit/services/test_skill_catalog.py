from __future__ import annotations

from pathlib import Path

from mycli.services.context.skill_catalog import render_skill_catalog
from mycli.services.skills import SkillRegistry


def test_render_skill_catalog_lists_names_and_descriptions(tmp_path: Path) -> None:
    builtin = tmp_path / "builtin"
    user = tmp_path / "home" / ".mycli" / "skills"
    builtin.mkdir(parents=True)
    (builtin / "code-review.md").write_text(
        "---\n"
        'name = "code-review"\n'
        'description = "Review code for correctness risks"\n'
        'trigger_hints = ["review"]\n'
        "---\n"
        "Body is not part of catalog.\n",
        encoding="utf-8",
    )
    registry = SkillRegistry(builtin_root=builtin, user_root=user)

    catalog = render_skill_catalog(registry)

    assert "Available skills:" in catalog
    assert "- code-review: Review code for correctness risks" in catalog
    assert f"(file: {builtin / 'code-review.md'})" in catalog
    assert "Body is not part of catalog" not in catalog
    assert "Use the Skill tool" in catalog


def test_render_skill_catalog_is_empty_without_skills(tmp_path: Path) -> None:
    registry = SkillRegistry(
        builtin_root=tmp_path / "builtin",
        user_root=tmp_path / "home" / ".mycli" / "skills",
    )

    assert render_skill_catalog(registry) == ""
