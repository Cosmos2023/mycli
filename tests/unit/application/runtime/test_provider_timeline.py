from __future__ import annotations

from pathlib import Path

from mycli.application.runtime.request.provider_timeline import (
    ProviderTimelineCoordinator,
    ProviderTimelineProjector,
    ProviderTimelineState,
)
from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import InstructionContract, InstructionFragment
from mycli.state.session_service import SessionService


def _contract(*, environment: str, permission: str = "D0") -> InstructionContract:
    return InstructionContract(
        base_instructions="S",
        developer_sections=(
            InstructionFragment(
                kind="permissions",
                title="Runtime permissions",
                content=permission,
                source="runtime",
                metadata={"cache_class": "dynamic", "model_visible": True},
            ),
        ),
        contextual_user_sections=(
            InstructionFragment(
                kind="environment_context",
                title="Environment context",
                content=environment,
                source="runtime",
                metadata={"cache_class": "dynamic", "model_visible": True},
            ),
        ),
        current_user_request="",
    )


def test_provider_timeline_appends_context_updates_at_their_turn_boundary() -> None:
    projector = ProviderTimelineProjector()
    first_conversation = (Message(role="user", content="U1"),)

    first = projector.project(
        state=ProviderTimelineState(),
        contract=_contract(environment="E0"),
        conversation=first_conversation,
        current_user_request="U1",
    )

    assert [(item.role, item.content) for item in first.messages] == [
        ("developer", "D0"),
        ("user", "E0"),
        ("user", "U1"),
    ]

    second_conversation = (
        *first_conversation,
        Message(role="assistant", content="A1"),
        Message(role="user", content="U2"),
    )
    second = projector.project(
        state=first,
        contract=_contract(environment="E1"),
        conversation=second_conversation,
        current_user_request="U2",
    )

    assert [(item.role, item.content) for item in second.messages] == [
        ("developer", "D0"),
        ("user", "E0"),
        ("user", "U1"),
        ("assistant", "A1"),
        ("user", "E1"),
        ("user", "U2"),
    ]


def test_provider_timeline_does_not_repeat_unchanged_context() -> None:
    projector = ProviderTimelineProjector()
    first = projector.project(
        state=ProviderTimelineState(),
        contract=_contract(environment="E0"),
        conversation=(Message(role="user", content="U1"),),
        current_user_request="U1",
    )

    second = projector.project(
        state=first,
        contract=_contract(environment="E0"),
        conversation=(
            Message(role="user", content="U1"),
            Message(role="assistant", content="A1"),
            Message(role="user", content="U2"),
        ),
        current_user_request="U2",
    )

    assert second.messages[: len(first.messages)] == first.messages
    assert [item.content for item in second.messages] == ["D0", "E0", "U1", "A1", "U2"]


def test_provider_timeline_state_round_trip_preserves_roles_and_source_cursor() -> None:
    projected = ProviderTimelineProjector().project(
        state=ProviderTimelineState(),
        contract=_contract(environment="E0"),
        conversation=(Message(role="user", content="U1"),),
        current_user_request="U1",
    )

    restored = ProviderTimelineState.from_dict(projected.to_dict())

    assert [(item.role, item.content) for item in restored.messages] == [
        ("developer", "D0"),
        ("user", "E0"),
        ("user", "U1"),
    ]
    assert [(item.role, item.content) for item in restored.source_messages] == [
        ("user", "U1"),
    ]


def test_provider_timeline_upgrades_legacy_interruption_marker_to_developer() -> None:
    marker = Message(
        role="user",
        content="<turn_aborted>interrupted</turn_aborted>",
        metadata={"event_kind": "turn_aborted_marker"},
    )

    projected = ProviderTimelineProjector().project(
        state=ProviderTimelineState(),
        contract=_contract(environment="E0"),
        conversation=(marker, Message(role="user", content="U2")),
        current_user_request="U2",
    )

    assert projected.messages[-2].role == "developer"
    assert projected.source_messages[-2].role == "user"


def test_provider_timeline_resets_when_source_conversation_was_edited() -> None:
    projector = ProviderTimelineProjector()
    first = projector.project(
        state=ProviderTimelineState(),
        contract=_contract(environment="E0"),
        conversation=(Message(role="user", content="U1"),),
        current_user_request="U1",
    )

    reset = projector.project(
        state=first,
        contract=_contract(environment="E0"),
        conversation=(Message(role="user", content="U1 edited"),),
        current_user_request="U1 edited",
    )

    assert reset.reset_count == 1
    assert [message.content for message in reset.messages] == ["D0", "E0", "U1 edited"]


def test_provider_timeline_appends_removed_context_tombstone_before_next_user() -> None:
    projector = ProviderTimelineProjector()
    first = projector.project(
        state=ProviderTimelineState(),
        contract=_contract(environment="E0"),
        conversation=(Message(role="user", content="U1"),),
        current_user_request="U1",
    )
    developer_only = InstructionContract(
        base_instructions="S",
        developer_sections=_contract(environment="E0").developer_sections,
    )

    second = projector.project(
        state=first,
        contract=developer_only,
        conversation=(
            Message(role="user", content="U1"),
            Message(role="assistant", content="A1"),
            Message(role="user", content="U2"),
        ),
        current_user_request="U2",
    )

    contents = [message.content for message in second.messages]
    assert contents[-1] == "U2"
    assert 'kind="environment_context" status="inactive"' in contents[-2]


def test_provider_timeline_coordinator_persists_and_projects_contract(
    tmp_path: Path,
) -> None:
    service = SessionService(home_dir=tmp_path)
    conversation = Conversation(
        session_id="session-1",
        messages=[Message(role="user", content="U1")],
    )
    coordinator = ProviderTimelineCoordinator(
        session_id="session-1",
        session_service=service,
    )

    projected = coordinator.project_and_persist(
        contract=_contract(environment="E0"),
        conversation=conversation,
        current_user_request="U1",
    )

    assert projected.base_instructions == "S"
    assert projected.developer_sections == ()
    assert projected.contextual_user_sections == ()
    assert projected.current_user_request == ""
    assert [(item.role, item.content) for item in projected.conversation_messages] == [
        ("developer", "D0"),
        ("user", "E0"),
        ("user", "U1"),
    ]

    resumed = ProviderTimelineCoordinator(
        session_id="session-1",
        session_service=service,
    )
    restored = resumed.load_state()
    assert [(item.role, item.content) for item in restored.messages] == [
        ("developer", "D0"),
        ("user", "E0"),
        ("user", "U1"),
    ]
