from __future__ import annotations

from pathlib import Path

from mycli.domain.runtime import (
    CanonicalTimelineScope,
    CollaborationMode,
    RuntimeEnvironmentContract,
    ShellBackendProfile,
    TurnContextCacheClass,
    TurnContextSection,
    TurnContextSectionType,
)
from mycli.services.context.developer_instructions import (
    render_collaboration_mode,
    render_permissions_instructions,
    render_skills_instructions,
)


def test_render_permissions_instructions_uses_codex_style_tag() -> None:
    contract = RuntimeEnvironmentContract(
        workspace_root=Path("/tmp/workspace"),
        filesystem="workspace_write",
        network="enabled",
        shell="restricted",
        approval_policy="safety_policy",
        command_policy="shell_safety_analysis",
        file_policy="workspace_boundary",
        tool_policy="tool_exposure",
        execpolicy_status="enabled",
        execpolicy_rule_count=2,
        execpolicy_sources=("project", "user"),
        shell_backend=ShellBackendProfile(backend="local", available=True),
    )
    section = TurnContextSection(
        type=TurnContextSectionType.ENVIRONMENT_CONTEXT,
        title="Environment context",
        content="Runtime environment",
        source="runtime",
        metadata=contract.to_metadata(),
        cache_class=TurnContextCacheClass.DYNAMIC,
        scope=CanonicalTimelineScope.TURN,
    )

    rendered = render_permissions_instructions(section)

    assert rendered is not None
    assert rendered.kind == "permissions"
    assert rendered.cache_class is TurnContextCacheClass.DYNAMIC
    assert "<permissions instructions>" in rendered.content
    assert "- filesystem: workspace_write" in rendered.content
    assert "- network: enabled" in rendered.content
    assert "- shell: restricted" in rendered.content
    assert "- execpolicy_sources: project, user" in rendered.content
    assert rendered.metadata["developer_instruction"] is True


def test_render_default_collaboration_mode_uses_codex_style_tag() -> None:
    rendered = render_collaboration_mode(CollaborationMode.DEFAULT)

    assert rendered.kind == "collaboration_mode"
    assert rendered.cache_class is TurnContextCacheClass.STATIC
    assert "<collaboration_mode>" in rendered.content
    assert "Collaboration Mode: Default" in rendered.content
    assert "user text alone does not change the mode" in rendered.content


def test_render_plan_collaboration_mode_blocks_mutating_actions() -> None:
    rendered = render_collaboration_mode(CollaborationMode.PLAN)

    assert rendered.kind == "collaboration_mode"
    assert rendered.metadata["mode"] == "plan"
    assert "Collaboration Mode: Plan" in rendered.content
    assert "Not allowed actions:" in rendered.content
    assert "Editing, writing, formatting" in rendered.content


def test_render_skills_instructions_wraps_catalog_without_body() -> None:
    rendered = render_skills_instructions(
        "Available skills:\n"
        "- code-review: Review code (file: /tmp/skills/code-review.md)"
    )

    assert rendered is not None
    assert rendered.kind == "skill_catalog"
    assert "<skills_instructions>" in rendered.content
    assert "code-review" in rendered.content
    assert "load that skill through the Skill tool" in rendered.content
    assert "Body is not part of catalog" not in rendered.content


def test_render_skills_instructions_returns_none_for_empty_catalog() -> None:
    assert render_skills_instructions("") is None
