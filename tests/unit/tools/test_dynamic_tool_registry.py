from mycli.domain.dynamic_tools import (
    DynamicToolConflictOutcome,
    DynamicToolDescriptor,
    DynamicToolLifecycleState,
    DynamicToolRegistration,
    DynamicToolScope,
    DynamicToolSource,
)
from mycli.tools.dynamic.registry import DynamicToolRegistry


def _registration(
    tool_id: str,
    route_name: str,
    *,
    scope: DynamicToolScope = DynamicToolScope.THREAD,
) -> DynamicToolRegistration:
    return DynamicToolRegistration(
        descriptor=DynamicToolDescriptor(
            tool_id=tool_id,
            route_name=route_name,
            source=DynamicToolSource.RUNTIME,
            scope=scope,
        ),
        tool=object(),
    )


def test_dynamic_tool_registry_rejects_duplicate_tool_ids() -> None:
    registry = DynamicToolRegistry()
    assert registry.register(_registration("tool_1", "Inspect")).outcome == (
        DynamicToolConflictOutcome.ACCEPTED
    )

    result = registry.register(_registration("tool_1", "OtherInspect"))

    assert result.outcome == DynamicToolConflictOutcome.REJECTED_DUPLICATE_TOOL_ID
    assert result.registration is None


def test_dynamic_tool_registry_allows_turn_scope_to_shadow_thread_scope() -> None:
    registry = DynamicToolRegistry()
    registry.register(_registration("thread_tool", "Inspect", scope=DynamicToolScope.THREAD))

    result = registry.register(
        _registration("turn_tool", "Inspect", scope=DynamicToolScope.TURN)
    )

    assert result.outcome == DynamicToolConflictOutcome.SHADOWS_THREAD_SCOPE
    assert [item.descriptor.tool_id for item in registry.get_visible_registrations()] == [
        "turn_tool"
    ]


def test_dynamic_tool_registry_expires_turn_scoped_tools() -> None:
    registry = DynamicToolRegistry()
    registry.register(_registration("thread_tool", "Inspect", scope=DynamicToolScope.THREAD))
    registry.register(_registration("turn_tool", "Summarize", scope=DynamicToolScope.TURN))

    events = registry.expire_turn_scoped()

    assert [event.tool_id for event in events] == ["turn_tool"]
    assert events[0].state is DynamicToolLifecycleState.EXPIRED
    assert [item.descriptor.tool_id for item in registry.get_visible_registrations()] == [
        "thread_tool"
    ]
