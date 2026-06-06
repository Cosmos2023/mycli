from __future__ import annotations

from pathlib import Path

from mycli.application.runtime.tools.contributed_tool_registry import ToolContributionRegistry
from mycli.application.runtime.tools.tool_orchestrator import ToolOrchestrator
from mycli.domain.conversation import Conversation
from mycli.domain.runtime import PlanState
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.contributed_tools import ToolContributionLifecycleState
from mycli.services.skills import SkillRegistry, SkillToolContributionProvider
from mycli.services.tracing import TraceService
from mycli.tools.registry import ToolRegistry
from mycli.tools.routing.tool_exposure_planner import ToolExposurePlanner


def test_skill_provider_tool_flows_through_orchestrator_registry_and_router(
    tmp_path: Path,
) -> None:
    repo_root = tmp_path / "workspace" / ".mycli" / "skills"
    repo_root.mkdir(parents=True)
    (repo_root / "code-review.md").write_text(
        "---\n"
        'name = "code-review"\n'
        'description = "Review code for correctness risks"\n'
        'trigger_hints = ["review"]\n'
        "---\n"
        "Find correctness bugs before style issues.\n",
        encoding="utf-8",
    )
    skill_registry = SkillRegistry(
        builtin_root=tmp_path / "builtin",
        user_root=tmp_path / "home" / ".mycli" / "skills",
        repo_root=repo_root,
    )
    contribution_registry = ToolContributionRegistry()
    tool_registry = ToolRegistry(specs={}, executors={})
    orchestrator = ToolOrchestrator(
        session_id="skill-session",
        tool_registry=tool_registry,
        tool_exposure_planner=ToolExposurePlanner(tool_registry=tool_registry),
        contributed_tool_registry=contribution_registry,
        contributed_tool_providers=(SkillToolContributionProvider(skill_registry),),
        trace_service=TraceService(tmp_path / "traces"),
        append_turn_item=lambda **_kwargs: None,
    )

    planned = orchestrator.plan_tool_exposure(
        user_message="review this code",
        conversation=Conversation(session_id="skill-session"),
        plan_state=PlanState(),
    )
    registration = planned.contributed_tools["skill-code-review"]
    assert registration.descriptor.route_name == "skill-code-review"
    assert registration.descriptor.display_name == "skill-code-review"
    assert registration.descriptor.spec.name == "skill-code-review"

    router = orchestrator.build_tool_router(planned)
    result = router.execute(
        ToolCall(
            name="skill-code-review",
            arguments={"reason": "Need correctness review guidance"},
            reason="Verify skill provider route",
        ),
        exposure=planned.exposure,
    )
    legacy_result = router.execute(
        ToolCall(
            name="skill.code-review",
            arguments={"reason": "Legacy dotted route compatibility"},
            reason="Verify old route alias",
        ),
        exposure=planned.exposure,
    )
    lifecycle_states = [
        event.state
        for event in (*planned.lifecycle_events, *router.pop_lifecycle_events())
        if event.tool_id == "skill:code-review"
    ]

    assert result.success is True
    assert legacy_result.success is True
    assert result.summary == "Activated skill: code-review"
    assert result.raw_payload["source_kind"] == "repo"
    assert "Find correctness bugs" in str(result.raw_payload["content"])
    assert planned.exposure.callable_tool_names() == ("skill-code-review",)
    assert lifecycle_states == [
        ToolContributionLifecycleState.DECLARED,
        ToolContributionLifecycleState.EXPOSED,
        ToolContributionLifecycleState.INVOKED,
        ToolContributionLifecycleState.COMPLETED,
        ToolContributionLifecycleState.INVOKED,
        ToolContributionLifecycleState.COMPLETED,
    ]
    assert contribution_registry.snapshot()[0]["tool_id"] == "skill:code-review"
