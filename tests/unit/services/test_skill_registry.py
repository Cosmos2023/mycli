from pathlib import Path

from mycli.services.skill_registry import SkillRegistry


def test_skill_registry_prefers_user_skill_over_builtin(tmp_path: Path) -> None:
    builtin_dir = tmp_path / "builtin"
    user_dir = tmp_path / "home" / ".mycli" / "skills"
    builtin_dir.mkdir(parents=True)
    user_dir.mkdir(parents=True)

    (builtin_dir / "repository-analysis.md").write_text(
        '---\nname = "repository-analysis"\ndescription = "Builtin"\ntrigger_hints = ["repo"]\n---\nBuiltin body\n',
        encoding="utf-8",
    )
    (user_dir / "repository-analysis.md").write_text(
        '---\nname = "repository-analysis"\ndescription = "User override"\ntrigger_hints = ["repo"]\n---\nUser body\n',
        encoding="utf-8",
    )

    registry = SkillRegistry(builtin_root=builtin_dir, user_root=user_dir)

    skill = registry.get("repository-analysis")
    assert skill is not None
    assert skill.description == "User override"
    assert skill.body == "User body"


def test_skill_registry_exposes_metadata_and_loads_body_on_demand(tmp_path: Path) -> None:
    builtin_dir = tmp_path / "builtin"
    user_dir = tmp_path / "home" / ".mycli" / "skills"
    builtin_dir.mkdir(parents=True)
    user_dir.mkdir(parents=True)

    (builtin_dir / "code-review.md").write_text(
        '---\nname = "code-review"\ndescription = "Builtin review"\ntrigger_hints = ["review"]\n---\nLoaded body\n',
        encoding="utf-8",
    )

    registry = SkillRegistry(builtin_root=builtin_dir, user_root=user_dir)

    metadata = registry.get_metadata("code-review")
    loaded = registry.load("code-review")

    assert metadata is not None
    assert metadata.name == "code-review"
    assert metadata.description == "Builtin review"
    assert loaded is not None
    assert loaded.body == "Loaded body"


def test_skill_registry_loads_capability_dependencies(tmp_path: Path) -> None:
    builtin_dir = tmp_path / "builtin"
    user_dir = tmp_path / "home" / ".mycli" / "skills"
    builtin_dir.mkdir(parents=True)
    user_dir.mkdir(parents=True)

    (builtin_dir / "deployment.md").write_text(
        "---\n"
        'name = "deployment"\n'
        'description = "Builtin deploy"\n'
        'trigger_hints = ["deploy"]\n'
        'env_dependencies = ["DEPLOY_TOKEN"]\n'
        'workspace_dependencies = ["infra/"]\n'
        "---\n"
        "Deploy body\n",
        encoding="utf-8",
    )

    registry = SkillRegistry(builtin_root=builtin_dir, user_root=user_dir)

    metadata = registry.get_metadata("deployment")
    loaded = registry.load("deployment")

    assert metadata is not None
    assert metadata.env_dependencies == ("DEPLOY_TOKEN",)
    assert metadata.workspace_dependencies == ("infra/",)
    assert loaded is not None
    assert loaded.env_dependencies == ("DEPLOY_TOKEN",)
    assert loaded.workspace_dependencies == ("infra/",)
