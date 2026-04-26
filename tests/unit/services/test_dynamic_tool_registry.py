from __future__ import annotations

from mycli.domain.dynamic_tools import (
    DynamicToolConflictOutcome,
    DynamicToolDescriptor,
    DynamicToolLifecycleState,
    DynamicToolRegistration,
    DynamicToolScope,
    DynamicToolSource,
)
from mycli.domain.tool_exposure import ToolRouteKey
from mycli.services.dynamic_tool_registry import DynamicToolRegistry
from mycli.tools.base import ToolParameter, ToolResultV2, ToolSpec


class FakeDynamicTool:
    def __init__(self, name: str) -> None:
        self.spec = ToolSpec(
            name=name,
            description=f"Tool {name}",
            parameters=(ToolParameter(name="path", type="string", required=False),),
        )

    def execute(self, arguments: dict[str, object]) -> ToolResultV2:
        return ToolResultV2(success=True, summary=f"{self.spec.name} ok", raw_payload=arguments)


def _registration(
    tool_id: str,
    *,
    route_name: str = "workspace_summary",
    scope: DynamicToolScope,
    state: DynamicToolLifecycleState = DynamicToolLifecycleState.DECLARED,
) -> DynamicToolRegistration:
    tool = FakeDynamicTool(route_name)
    return DynamicToolRegistration(
        descriptor=DynamicToolDescriptor(
            tool_id=tool_id,
            display_name=route_name,
            description=f"Tool {route_name}",
            route_key=ToolRouteKey.local(route_name),
            source=DynamicToolSource.RUNTIME,
            scope=scope,
            lifecycle_state=state,
            spec=tool.spec,
        ),
        tool=tool,
    )


def test_dynamic_tool_registry_reports_route_conflicts_for_same_scope() -> None:
    registry = DynamicToolRegistry()

    first = registry.register(_registration("runtime:workspace_summary:turn:a", scope=DynamicToolScope.TURN))
    second = registry.register(_registration("runtime:workspace_summary:turn:b", scope=DynamicToolScope.TURN))

    assert first.outcome is DynamicToolConflictOutcome.ACCEPTED
    assert second.outcome is DynamicToolConflictOutcome.REJECTED_ROUTE_CONFLICT


def test_dynamic_tool_registry_allows_turn_scope_to_shadow_thread_scope() -> None:
    registry = DynamicToolRegistry()
    thread_tool = _registration("runtime:workspace_summary:thread", scope=DynamicToolScope.THREAD)
    turn_tool = _registration("runtime:workspace_summary:turn", scope=DynamicToolScope.TURN)

    thread_result = registry.register(thread_tool)
    turn_result = registry.register(turn_tool)

    visible = registry.get_visible_registrations()

    assert thread_result.outcome is DynamicToolConflictOutcome.ACCEPTED
    assert turn_result.outcome is DynamicToolConflictOutcome.SHADOWS_THREAD_SCOPE
    assert [item.descriptor.tool_id for item in visible] == ["runtime:workspace_summary:turn"]


def test_dynamic_tool_registry_transitions_and_expires_turn_tools() -> None:
    registry = DynamicToolRegistry()
    thread_tool = _registration("runtime:daily_brief:thread", route_name="daily_brief", scope=DynamicToolScope.THREAD)
    turn_tool = _registration("runtime:workspace_summary:turn", scope=DynamicToolScope.TURN)
    registry.register(thread_tool)
    registry.register(turn_tool)

    invoked = registry.transition("runtime:workspace_summary:turn", DynamicToolLifecycleState.INVOKED)
    completed = registry.transition("runtime:workspace_summary:turn", DynamicToolLifecycleState.COMPLETED)
    expired = registry.expire_turn_scoped()
    snapshots = registry.snapshot()

    assert invoked is not None
    assert invoked.state is DynamicToolLifecycleState.INVOKED
    assert completed is not None
    assert completed.state is DynamicToolLifecycleState.COMPLETED
    assert len(expired) == 1
    assert expired[0].state is DynamicToolLifecycleState.EXPIRED
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
