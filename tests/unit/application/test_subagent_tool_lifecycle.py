from __future__ import annotations

from mycli.application.runtime.tools.contributed_tool_registry import ToolContributionRegistry
from mycli.application.runtime.tools.tool_orchestrator import ToolOrchestrator
from mycli.domain.conversation import Conversation
from mycli.domain.runtime import PlanState
from mycli.domain.subagents import SubAgentResult
from mycli.domain.tooling.calls import ToolCall
from mycli.domain.tooling.contributed_tools import ToolContributionLifecycleState
from mycli.services.subagents import SubAgentToolContributionProvider
from mycli.services.tracing import TraceService
from mycli.tools.registry import ToolRegistry
from mycli.tools.routing.tool_exposure_planner import ToolExposurePlanner


class FakeSubAgentService:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def run_task(
        self,
        *,
        description: str,
        agent_type: str,
        allowed_tools: tuple[str, ...],
        mode: str = "sync",
    ) -> SubAgentResult:
        self.calls.append(
            {
                "description": description,
                "agent_type": agent_type,
                "allowed_tools": allowed_tools,
                "mode": mode,
            }
        )
        return SubAgentResult(
            status="completed",
            report='<sub-agent-report agent="explore" status="completed">ok</sub-agent-report>',
            child_session_id="demo:sub:turn_1:abcd1234",
            tool_calls=1,
        )


def test_subagent_provider_tool_flows_through_orchestrator_registry_and_router(
    tmp_path,
) -> None:
    service = FakeSubAgentService()
    contribution_registry = ToolContributionRegistry()
    tool_registry = ToolRegistry(specs={}, executors={})
    provider = SubAgentToolContributionProvider(service=service)
    orchestrator = ToolOrchestrator(
        session_id="subagent-session",
        tool_registry=tool_registry,
        tool_exposure_planner=ToolExposurePlanner(tool_registry=tool_registry),
        contributed_tool_registry=contribution_registry,
        contributed_tool_providers=(provider,),
        trace_service=TraceService(tmp_path / "traces"),
        append_turn_item=lambda **_kwargs: None,
    )

    planned = orchestrator.plan_tool_exposure(
        user_message="explore this repo",
        conversation=Conversation(session_id="subagent-session"),
        plan_state=PlanState(),
    )
    router = orchestrator.build_tool_router(planned)
    result = router.execute(
        ToolCall(
            name="subagent_explore",
            arguments={
                "description": "Map repository docs",
                "allowed_tools": ["Read", "Grep"],
            },
            reason="Verify subagent provider route",
        ),
        exposure=planned.exposure,
    )
    lifecycle_states = [
        event.state
        for event in (*planned.lifecycle_events, *router.pop_lifecycle_events())
        if event.tool_id == "subagent:explore"
    ]

    assert result.success is True
    assert result.summary == "Sub-agent explore completed with status completed."
    assert result.artifacts["child_session_id"] == "demo:sub:turn_1:abcd1234"
    assert result.raw_payload["run_id"] == "demo:sub:turn_1:abcd1234"
    assert result.raw_payload["trace"]["status"] == "completed"
    assert result.raw_payload["artifacts"]["child_session_id"] == "demo:sub:turn_1:abcd1234"
    assert service.calls == [
        {
            "description": "Map repository docs",
            "agent_type": "explore",
            "allowed_tools": ("Read", "Grep"),
            "mode": "sync",
        }
    ]
    assert planned.exposure.callable_tool_names() == (
        "subagent_executor",
        "subagent_explore",
        "subagent_review",
    )
    assert lifecycle_states == [
        ToolContributionLifecycleState.DECLARED,
        ToolContributionLifecycleState.EXPOSED,
        ToolContributionLifecycleState.INVOKED,
        ToolContributionLifecycleState.COMPLETED,
    ]
    assert contribution_registry.snapshot()[1]["tool_id"] == "subagent:explore"
