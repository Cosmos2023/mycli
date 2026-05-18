from __future__ import annotations

from pathlib import Path

from mycli.services.skills import SkillRegistry
from mycli.tools.skill import SkillTool


def _write_skill(root: Path, name: str = "code-review") -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / f"{name}.md").write_text(
        "---\n"
        f'name = "{name}"\n'
        'description = "Review code for correctness risks"\n'
        'trigger_hints = ["review"]\n'
        "---\n"
        "Find correctness bugs before style issues.\n",
        encoding="utf-8",
    )


def test_skill_tool_returns_markdown_body_as_tool_result(tmp_path: Path) -> None:
    builtin = tmp_path / "builtin"
    user = tmp_path / "home" / ".mycli" / "skills"
    _write_skill(builtin)
    registry = SkillRegistry(builtin_root=builtin, user_root=user)

    result = SkillTool(registry).execute({"skill_name": "code-review"})

    assert result.success is True
    assert result.summary == "Activated skill: code-review"
    assert result.raw_payload["skill_name"] == "code-review"
    assert result.raw_payload["description"] == "Review code for correctness risks"
    assert result.raw_payload["content"] == "Find correctness bugs before style issues."
    assert result.raw_payload["source_path"].endswith("code-review.md")
    assert "kind" not in result.raw_payload
    assert "body" not in result.raw_payload


def test_skill_tool_rejects_missing_or_unknown_skill(tmp_path: Path) -> None:
    registry = SkillRegistry(
        builtin_root=tmp_path / "builtin",
        user_root=tmp_path / "home" / ".mycli" / "skills",
    )

    missing_name = SkillTool(registry).execute({})
    unknown = SkillTool(registry).execute({"skill_name": "missing"})

    assert missing_name.success is False
    assert "skill_name is required" in str(missing_name.error)
    assert unknown.success is False
    assert "not found" in str(unknown.error)
