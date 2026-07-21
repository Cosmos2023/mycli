from __future__ import annotations

from pathlib import Path

import pytest

from mycli.application.runtime.user_message_lifecycle import UserMessageLifecycle
from mycli.domain.conversation import Conversation
from mycli.domain.runtime import (
    HistoryItemType,
    RuntimeStreamEvent,
    TurnItem,
    TurnItemType,
    UserMessageIdConflictError,
    UserMessageInput,
)
from mycli.state.session_service import SessionService


def _lifecycle(
    tmp_path: Path,
) -> tuple[UserMessageLifecycle, SessionService]:
    service = SessionService(home_dir=tmp_path, workspace_root=tmp_path)

    def append_turn_item(
        *,
        turn_id: str,
        turn_items: list[TurnItem],
        item: TurnItem,
    ) -> None:
        assert turn_id == "turn-1"
        turn_items.append(item)

    return (
        UserMessageLifecycle(
            session_id="demo",
            session_service=service,
            append_turn_item=append_turn_item,
        ),
        service,
    )


def test_commit_persists_before_user_item_lifecycle(tmp_path: Path) -> None:
    lifecycle, service = _lifecycle(tmp_path)
    conversation = Conversation(session_id="demo")
    turn_items: list[TurnItem] = []
    events: list[RuntimeStreamEvent] = []
    persisted_at_event: list[bool] = []

    def stream_sink(event: RuntimeStreamEvent) -> None:
        persisted_at_event.append(bool(service.load_history_items("demo")))
        events.append(event)

    committed = lifecycle.commit(
        turn_id="turn-1",
        item=UserMessageInput("client-1", "inspect", source="submit"),
        conversation=conversation,
        turn_items=turn_items,
        stream_sink=stream_sink,
    )

    assert committed.history_id == "turn-1:user:client-1"
    assert committed.client_user_message_id == "client-1"
    assert persisted_at_event == [True, True]
    assert [event.kind for event in events] == ["item_started", "item_completed"]
    assert events[1].metadata["item"] == {
        "id": "turn-1:user:client-1",
        "type": "user_message",
        "client_user_message_id": "client-1",
        "content": "inspect",
        "source": "submit",
    }

    history = service.load_history_items("demo")
    assert len(history) == 1
    assert history[0].type is HistoryItemType.USER_MESSAGE
    assert history[0].metadata == {
        "client_user_message_id": "client-1",
        "source": "submit",
        "image_paths": [],
    }
    assert conversation.messages[0].role == "user"
    assert conversation.messages[0].content == "inspect"
    assert turn_items == [
        TurnItem(
            type=TurnItemType.USER_MESSAGE,
            text="inspect",
            metadata={
                "client_user_message_id": "client-1",
                "source": "submit",
                "image_paths": [],
                "history_committed": True,
            },
        )
    ]


def test_commit_retry_is_idempotent(tmp_path: Path) -> None:
    lifecycle, service = _lifecycle(tmp_path)
    conversation = Conversation(session_id="demo")
    turn_items: list[TurnItem] = []
    events: list[RuntimeStreamEvent] = []
    item = UserMessageInput("client-1", "inspect", source="submit")

    first = lifecycle.commit(
        turn_id="turn-1",
        item=item,
        conversation=conversation,
        turn_items=turn_items,
        stream_sink=events.append,
    )
    second = lifecycle.commit(
        turn_id="turn-1",
        item=item,
        conversation=conversation,
        turn_items=turn_items,
        stream_sink=events.append,
    )

    assert second == first
    assert len(conversation.messages) == 1
    assert len(service.load_history_items("demo")) == 1
    assert len(turn_items) == 1
    assert [event.kind for event in events] == ["item_started", "item_completed"]


def test_commit_rejects_conflicting_message_id(tmp_path: Path) -> None:
    lifecycle, _ = _lifecycle(tmp_path)
    conversation = Conversation(session_id="demo")
    turn_items: list[TurnItem] = []
    lifecycle.commit(
        turn_id="turn-1",
        item=UserMessageInput("client-1", "inspect", source="submit"),
        conversation=conversation,
        turn_items=turn_items,
        stream_sink=None,
    )

    with pytest.raises(UserMessageIdConflictError):
        lifecycle.commit(
            turn_id="turn-1",
            item=UserMessageInput("client-1", "different", source="submit"),
            conversation=conversation,
            turn_items=turn_items,
            stream_sink=None,
        )

    assert [message.content for message in conversation.messages] == ["inspect"]


def test_commit_rolls_back_conversation_when_persistence_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lifecycle, service = _lifecycle(tmp_path)
    conversation = Conversation(session_id="demo")
    turn_items: list[TurnItem] = []
    events: list[RuntimeStreamEvent] = []

    def fail_append(*args: object, **kwargs: object) -> None:
        del args, kwargs
        raise OSError("disk full")

    monkeypatch.setattr(service, "append_history_items", fail_append)

    with pytest.raises(OSError, match="disk full"):
        lifecycle.commit(
            turn_id="turn-1",
            item=UserMessageInput("client-1", "inspect", source="submit"),
            conversation=conversation,
            turn_items=turn_items,
            stream_sink=events.append,
        )

    assert conversation.messages == []
    assert turn_items == []
    assert events == []
