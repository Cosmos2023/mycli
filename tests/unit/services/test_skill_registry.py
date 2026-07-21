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


def test_skill_registry_discovers_repo_skills_and_source_metadata(tmp_path: Path) -> None:
    builtin_dir = tmp_path / "builtin"
    user_dir = tmp_path / "home" / ".mycli" / "skills"
    repo_dir = tmp_path / "workspace" / ".mycli" / "skills"
    repo_dir.mkdir(parents=True)
    (repo_dir / "data-helper.md").write_text(
        "---\n"
        'name = "data-helper"\n'
        'description = "Analyze local CSV data"\n'
        'trigger_hints = ["csv"]\n'
        'guardrails = ["Do not invent numbers"]\n'
        "---\n"
        "Use pandas-like reasoning.\n",
        encoding="utf-8",
    )

    registry = SkillRegistry(builtin_root=builtin_dir, user_root=user_dir, repo_root=repo_dir)
    metadata = registry.get_metadata("data-helper")
    loaded = registry.load("data-helper")
    diagnostics = registry.diagnostics()

    assert metadata is not None
    assert metadata.source_kind == "repo"
    assert metadata.guardrails == ("Do not invent numbers",)
    assert loaded is not None
    assert loaded.source_kind == "repo"
    assert loaded.guardrails == ("Do not invent numbers",)
    assert diagnostics.loaded_count == 1
    assert diagnostics.source_counts == (("repo", 1),)


def test_skill_registry_discovers_standard_skill_directories_only(tmp_path: Path) -> None:
    builtin_dir = tmp_path / "builtin"
    user_dir = tmp_path / "home" / ".mycli" / "skills"
    skill_dir = user_dir / "release-helper"
    references_dir = skill_dir / "references"
    references_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        'name = "release-helper"\n'
        'description = "Prepare releases"\n'
        "---\n"
        "Release instructions.\n",
        encoding="utf-8",
    )
    (references_dir / "ignored.md").write_text(
        "---\n"
        'name = "ignored-reference"\n'
        'description = "Support material, not a skill"\n'
        "---\n"
        "Reference body.\n",
        encoding="utf-8",
    )

    registry = SkillRegistry(builtin_root=builtin_dir, user_root=user_dir)

    skill = registry.load("release-helper")
    assert skill is not None
    assert skill.body == "Release instructions."
    assert skill.source_path == str(skill_dir / "SKILL.md")
    assert registry.get("ignored-reference") is None


def test_skill_registry_applies_source_and_format_precedence(tmp_path: Path) -> None:
    builtin_dir = tmp_path / "builtin"
    user_dir = tmp_path / "home" / ".mycli" / "skills"
    shared_repo_dir = tmp_path / "workspace" / ".agents" / "skills"
    repo_dir = tmp_path / "workspace" / ".mycli" / "skills"
    for directory in (builtin_dir, user_dir, shared_repo_dir, repo_dir):
        directory.mkdir(parents=True)

    def write_flat(root: Path, filename: str, name: str, description: str) -> None:
        (root / filename).write_text(
            "---\n"
            f'name = "{name}"\n'
            f'description = "{description}"\n'
            "---\n"
            f"{description} body.\n",
            encoding="utf-8",
        )

    def write_standard(root: Path, directory_name: str, name: str, description: str) -> None:
        skill_dir = root / directory_name
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text(
            "---\n"
            f'name = "{name}"\n'
            f'description = "{description}"\n'
            "---\n"
            f"{description} body.\n",
            encoding="utf-8",
        )

    for root, description in (
        (builtin_dir, "Builtin source"),
        (user_dir, "User source"),
        (shared_repo_dir, "Shared repo source"),
        (repo_dir, "Mycli repo source"),
    ):
        write_flat(root, "source-priority.md", "source-priority", description)
    write_flat(user_dir, "shared-priority.md", "shared-priority", "User source")
    write_flat(
        shared_repo_dir,
        "shared-priority.md",
        "shared-priority",
        "Shared repo source",
    )
    write_flat(repo_dir, "format-priority.md", "format-priority", "Flat repo format")
    write_standard(
        repo_dir,
        "format-priority",
        "format-priority",
        "Directory repo format",
    )

    registry = SkillRegistry(
        builtin_root=builtin_dir,
        user_root=user_dir,
        shared_repo_root=shared_repo_dir,
        repo_root=repo_dir,
    )

    assert registry.get_metadata("source-priority").description == "Mycli repo source"
    assert registry.get_metadata("source-priority").source_kind == "repo"
    assert registry.get_metadata("shared-priority").description == "Shared repo source"
    assert registry.get_metadata("shared-priority").source_kind == "shared_repo"
    assert registry.get_metadata("format-priority").description == "Directory repo format"
    assert registry.get_metadata("format-priority").source_path == str(
        repo_dir / "format-priority" / "SKILL.md"
    )


def test_skill_registry_reports_duplicates_and_invalid_files_without_bodies(tmp_path: Path) -> None:
    builtin_dir = tmp_path / "builtin"
    user_dir = tmp_path / "home" / ".mycli" / "skills"
    repo_dir = tmp_path / "workspace" / ".mycli" / "skills"
    builtin_dir.mkdir(parents=True)
    user_dir.mkdir(parents=True)
    repo_dir.mkdir(parents=True)
    body_text = "SECRET BODY SHOULD NOT APPEAR"
    (builtin_dir / "review.md").write_text(
        '---\nname = "review"\ndescription = "Builtin review"\n---\nBuiltin\n',
        encoding="utf-8",
    )
    (repo_dir / "review.md").write_text(
        f'---\nname = "review"\ndescription = "Repo review"\n---\n{body_text}\n',
        encoding="utf-8",
    )
    (user_dir / "broken.md").write_text("not frontmatter", encoding="utf-8")

    registry = SkillRegistry(builtin_root=builtin_dir, user_root=user_dir, repo_root=repo_dir)
    diagnostics = registry.diagnostics()
    detail = diagnostics.safe_detail()

    assert registry.get_metadata("review").source_kind == "repo"
    assert diagnostics.loaded_count == 1
    assert diagnostics.duplicate_count == 1
    assert diagnostics.issue_count == 1
    assert "duplicate_skill:review:review:2 definitions" in detail
    assert "invalid_skill:broken.md" in detail
    assert body_text not in detail
