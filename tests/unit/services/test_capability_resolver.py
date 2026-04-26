from __future__ import annotations

from pathlib import Path

from mycli.domain.capabilities import CapabilityActivationDependencyStatus, CapabilityActivationSource
from mycli.services.capability_resolver import CapabilityResolver
from mycli.services.skill_registry import SkillRegistry


def _build_registry(tmp_path: Path) -> SkillRegistry:
    builtin_dir = tmp_path / "builtin"
    user_dir = tmp_path / "home" / ".mycli" / "skills"
    builtin_dir.mkdir(parents=True)
    user_dir.mkdir(parents=True)
    (builtin_dir / "repository-analysis.md").write_text(
        "---\n"
        'name = "repository-analysis"\n'
        'description = "Inspect repos"\n'
        'trigger_hints = ["repo"]\n'
        'workspace_dependencies = ["pyproject.toml"]\n'
        "---\n"
        "Inspect repositories before answering.\n",
        encoding="utf-8",
    )
    (builtin_dir / "deployment.md").write_text(
        "---\n"
        'name = "deployment"\n'
        'description = "Deploy project"\n'
        'trigger_hints = ["deploy"]\n'
        'env_dependencies = ["DEPLOY_TOKEN"]\n'
        "---\n"
        "Deploy only when credentials are configured.\n",
        encoding="utf-8",
    )
    return SkillRegistry(builtin_root=builtin_dir, user_root=user_dir)


def test_capability_resolver_supports_explicit_mentions(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")
    resolver = CapabilityResolver(
        skill_registry=_build_registry(tmp_path),
        workspace_root=tmp_path,
        env={},
    )

    activations = resolver.resolve("请使用 $repository-analysis 来分析这个仓库")

    assert len(activations) == 1
    assert activations[0].name == "repository-analysis"
    assert activations[0].source is CapabilityActivationSource.EXPLICIT_MENTION
    assert activations[0].dependency_status is CapabilityActivationDependencyStatus.READY


def test_capability_resolver_keeps_trigger_hint_activation(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")
    resolver = CapabilityResolver(
        skill_registry=_build_registry(tmp_path),
        workspace_root=tmp_path,
        env={},
    )

    activations = resolver.resolve("inspect this repo for me")

    assert len(activations) == 1
    assert activations[0].source is CapabilityActivationSource.TRIGGER_HINT


def test_capability_resolver_prefers_explicit_mentions_over_trigger_hints(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")
    resolver = CapabilityResolver(
        skill_registry=_build_registry(tmp_path),
        workspace_root=tmp_path,
        env={},
    )

    activations = resolver.resolve("inspect this repo with $repository-analysis")

    assert len(activations) == 1
    assert activations[0].source is CapabilityActivationSource.EXPLICIT_MENTION


def test_capability_resolver_marks_missing_env_dependencies(tmp_path: Path) -> None:
    resolver = CapabilityResolver(
        skill_registry=_build_registry(tmp_path),
        workspace_root=tmp_path,
        env={},
    )

    activations = resolver.resolve("please use $deployment")

    assert len(activations) == 1
    assert activations[0].dependency_status is CapabilityActivationDependencyStatus.MISSING_ENV
    assert activations[0].metadata["missing_env_dependencies"] == ["DEPLOY_TOKEN"]


def test_capability_resolver_marks_missing_workspace_dependencies(tmp_path: Path) -> None:
    resolver = CapabilityResolver(
        skill_registry=_build_registry(tmp_path),
        workspace_root=tmp_path,
        env={"DEPLOY_TOKEN": "x"},
    )

    activations = resolver.resolve("please use $repository-analysis")

    assert len(activations) == 1
    assert (
        activations[0].dependency_status
        is CapabilityActivationDependencyStatus.MISSING_WORKSPACE_RESOURCE
    )
    assert activations[0].metadata["missing_workspace_dependencies"] == ["pyproject.toml"]
