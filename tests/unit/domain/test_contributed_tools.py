from __future__ import annotations

from mycli.domain.tooling.contributed_tools import (
    ToolContributionConflictOutcome,
    ToolContributionDescriptor,
    ToolContributionLifecycleEvent,
    ToolContributionLifecycleState,
    ToolContributionScope,
    ToolContributionSource,
)
from mycli.domain.tooling.exposure import ToolRouteKey
from mycli.tools.base import ToolParameter, ToolSpec


def test_contributed_tool_descriptor_exposes_stable_identity_and_route() -> None:
    descriptor = ToolContributionDescriptor(
        tool_id="runtime:workspace_summary:thread",
        display_name="workspace_summary",
        description="Summarize workspace facts",
        route_key=ToolRouteKey.local("workspace_summary"),
        source=ToolContributionSource.RUNTIME,
        scope=ToolContributionScope.THREAD,
        lifecycle_state=ToolContributionLifecycleState.DECLARED,
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


def test_contributed_tool_descriptor_updates_lifecycle_in_snapshot() -> None:
    descriptor = ToolContributionDescriptor(
        tool_id="provider:daily_brief:turn",
        display_name="daily_brief",
        description="Prepare a daily brief",
        route_key=ToolRouteKey.local("daily_brief"),
        source=ToolContributionSource.PROVIDER,
        scope=ToolContributionScope.TURN,
        lifecycle_state=ToolContributionLifecycleState.DECLARED,
        spec=ToolSpec(name="daily_brief", description="Prepare a daily brief"),
        origin_metadata={"provider_name": "daily-assistant"},
    )

    updated = descriptor.with_lifecycle_state(ToolContributionLifecycleState.EXPOSED)

    assert updated.lifecycle_state is ToolContributionLifecycleState.EXPOSED
    assert updated.to_snapshot() == {
        "tool_id": "provider:daily_brief:turn",
        "display_name": "daily_brief",
        "description": "Prepare a daily brief",
        "route_name": "daily_brief",
        "source": "provider",
        "scope": "turn",
        "state": "exposed",
        "origin_metadata": {"provider_name": "daily-assistant"},
    }


def test_contributed_tool_lifecycle_event_serializes_scope_state_and_origin() -> None:
    event = ToolContributionLifecycleEvent(
        tool_id="runtime:workspace_summary:turn",
        route_name="workspace_summary",
        scope=ToolContributionScope.TURN,
        state=ToolContributionLifecycleState.EXPIRED,
        source=ToolContributionSource.RUNTIME,
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
    assert ToolContributionConflictOutcome.SHADOWS_THREAD_SCOPE.value == "shadows_thread_scope"
