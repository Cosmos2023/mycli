from __future__ import annotations

from mycli.domain.contributed_tools import (
    ToolContributionConflictOutcome,
    ToolContributionDescriptor,
    ToolContributionLifecycleState,
    ToolContributionRegistration,
    ToolContributionScope,
    ToolContributionSource,
)
from mycli.domain.tool_exposure import ToolRouteKey
from mycli.application.runtime.tools.contributed_tool_registry import ToolContributionRegistry
from mycli.tools.base import ToolParameter, ToolResult, ToolSpec


class FakeToolContribution:
    def __init__(self, name: str) -> None:
        self.spec = ToolSpec(
            name=name,
            description=f"Tool {name}",
            parameters=(ToolParameter(name="path", type="string", required=False),),
        )

    def execute(self, arguments: dict[str, object]) -> ToolResult:
        return ToolResult(success=True, summary=f"{self.spec.name} ok", raw_payload=arguments)


def _registration(
    tool_id: str,
    *,
    route_name: str = "workspace_summary",
    scope: ToolContributionScope,
    state: ToolContributionLifecycleState = ToolContributionLifecycleState.DECLARED,
) -> ToolContributionRegistration:
    tool = FakeToolContribution(route_name)
    return ToolContributionRegistration(
        descriptor=ToolContributionDescriptor(
            tool_id=tool_id,
            display_name=route_name,
            description=f"Tool {route_name}",
            route_key=ToolRouteKey.local(route_name),
            source=ToolContributionSource.RUNTIME,
            scope=scope,
            lifecycle_state=state,
            spec=tool.spec,
        ),
        tool=tool,
    )


def test_contributed_tool_registry_reports_route_conflicts_for_same_scope() -> None:
    registry = ToolContributionRegistry()

    first = registry.register(_registration("runtime:workspace_summary:turn:a", scope=ToolContributionScope.TURN))
    second = registry.register(_registration("runtime:workspace_summary:turn:b", scope=ToolContributionScope.TURN))

    assert first.outcome is ToolContributionConflictOutcome.ACCEPTED
    assert second.outcome is ToolContributionConflictOutcome.REJECTED_ROUTE_CONFLICT


def test_contributed_tool_registry_allows_turn_scope_to_shadow_thread_scope() -> None:
    registry = ToolContributionRegistry()
    thread_tool = _registration("runtime:workspace_summary:thread", scope=ToolContributionScope.THREAD)
    turn_tool = _registration("runtime:workspace_summary:turn", scope=ToolContributionScope.TURN)

    thread_result = registry.register(thread_tool)
    turn_result = registry.register(turn_tool)

    visible = registry.get_visible_registrations()

    assert thread_result.outcome is ToolContributionConflictOutcome.ACCEPTED
    assert turn_result.outcome is ToolContributionConflictOutcome.SHADOWS_THREAD_SCOPE
    assert [item.descriptor.tool_id for item in visible] == ["runtime:workspace_summary:turn"]


def test_contributed_tool_registry_transitions_and_expires_turn_tools() -> None:
    registry = ToolContributionRegistry()
    thread_tool = _registration("runtime:daily_brief:thread", route_name="daily_brief", scope=ToolContributionScope.THREAD)
    turn_tool = _registration("runtime:workspace_summary:turn", scope=ToolContributionScope.TURN)
    registry.register(thread_tool)
    registry.register(turn_tool)

    invoked = registry.transition("runtime:workspace_summary:turn", ToolContributionLifecycleState.INVOKED)
    completed = registry.transition("runtime:workspace_summary:turn", ToolContributionLifecycleState.COMPLETED)
    expired = registry.expire_turn_scoped()
    snapshots = registry.snapshot()

    assert invoked is not None
    assert invoked.state is ToolContributionLifecycleState.INVOKED
    assert completed is not None
    assert completed.state is ToolContributionLifecycleState.COMPLETED
    assert len(expired) == 1
    assert expired[0].state is ToolContributionLifecycleState.EXPIRED
    assert snapshots == [
        {
            "tool_id": "runtime:daily_brief:thread",
            "display_name": "daily_brief",
            "description": "Tool daily_brief",
            "route_name": "daily_brief",
            "source": "runtime",
            "scope": "thread",
            "state": "declared",
            "origin_metadata": {},
        }
    ]
