from __future__ import annotations

from mycli.domain.dynamic_tools import (
    DynamicToolConflictOutcome,
    DynamicToolDescriptor,
    DynamicToolLifecycleEvent,
    DynamicToolLifecycleState,
    DynamicToolScope,
    DynamicToolSource,
)
from mycli.domain.tool_exposure import ToolRouteKey
from mycli.tools.base import ToolParameter, ToolSpec


def test_dynamic_tool_descriptor_exposes_stable_identity_and_route() -> None:
    descriptor = DynamicToolDescriptor(
        tool_id="runtime:workspace_summary:thread",
        display_name="workspace_summary",
        description="Summarize workspace facts",
        route_key=ToolRouteKey.local("workspace_summary"),
        source=DynamicToolSource.RUNTIME,
        scope=DynamicToolScope.THREAD,
        lifecycle_state=DynamicToolLifecycleState.DECLARED,
        spec=ToolSpec(
            name="workspace_summary",
            description="Summarize workspace facts",
            parameters=(ToolParameter(name="path", type="string", required=False),),
        ),
    )

    assert descriptor.tool_id == "runtime:workspace_summary:thread"
    assert descriptor.route_name == "workspace_summary"
    assert descriptor.scope.value == "thread"
    assert descriptor.lifecycle_state.value == "declared"


def test_dynamic_tool_descriptor_updates_lifecycle_in_snapshot() -> None:
    descriptor = DynamicToolDescriptor(
        tool_id="capability:daily_brief:turn",
        display_name="daily_brief",
        description="Prepare a daily brief",
        route_key=ToolRouteKey.local("daily_brief"),
        source=DynamicToolSource.CAPABILITY,
        scope=DynamicToolScope.TURN,
        lifecycle_state=DynamicToolLifecycleState.DECLARED,
        spec=ToolSpec(name="daily_brief", description="Prepare a daily brief"),
        origin_metadata={"capability_name": "daily-assistant"},
    )

    updated = descriptor.with_lifecycle_state(DynamicToolLifecycleState.EXPOSED)

    assert updated.lifecycle_state is DynamicToolLifecycleState.EXPOSED
    assert updated.to_snapshot() == {
        "tool_id": "capability:daily_brief:turn",
        "display_name": "daily_brief",
        "description": "Prepare a daily brief",
        "route_name": "daily_brief",
        "source": "capability",
        "scope": "turn",
        "state": "exposed",
        "origin_metadata": {"capability_name": "daily-assistant"},
    }


def test_dynamic_tool_lifecycle_event_serializes_scope_state_and_origin() -> None:
    event = DynamicToolLifecycleEvent(
        tool_id="runtime:workspace_summary:turn",
        route_name="workspace_summary",
        scope=DynamicToolScope.TURN,
        state=DynamicToolLifecycleState.EXPIRED,
        source=DynamicToolSource.RUNTIME,
        origin_metadata={"reason": "turn_end"},
    )

    assert event.to_dict() == {
        "tool_id": "runtime:workspace_summary:turn",
        "route_name": "workspace_summary",
        "scope": "turn",
        "state": "expired",
        "source": "runtime",
        "origin_metadata": {"reason": "turn_end"},
    }
    assert DynamicToolConflictOutcome.SHADOWS_THREAD_SCOPE.value == "shadows_thread_scope"
