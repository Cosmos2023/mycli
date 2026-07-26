from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import (
    HistoryItem,
    HistoryItemType,
    RuntimeBlock,
    RuntimeStreamEvent,
    TurnItem,
    TurnItemType,
    UserMessageIdConflictError,
    UserMessageInput,
)
from mycli.domain.runtime.images import local_image_block
from mycli.state.session_service import SessionService


@dataclass(frozen=True, slots=True)
class CommittedUserMessage:
    history_id: str
    client_user_message_id: str


class UserMessageLifecycle:
    def __init__(
        self,
        *,
        session_id: str,
        session_service: SessionService,
        append_turn_item: Callable[..., None],
    ) -> None:
        self._session_id = session_id
        self._session_service = session_service
        self._append_turn_item = append_turn_item

    def set_session_id(self, session_id: str) -> None:
        self._session_id = session_id

    def commit(
        self,
        *,
        turn_id: str,
        item: UserMessageInput,
        conversation: Conversation,
        turn_items: list[TurnItem],
        stream_sink: Callable[[RuntimeStreamEvent], None] | None,
    ) -> CommittedUserMessage:
        history_id = f"{turn_id}:user:{item.client_user_message_id}"
        committed = CommittedUserMessage(
            history_id=history_id,
            client_user_message_id=item.client_user_message_id,
        )
        existing = self._history_item(history_id)
        if existing is not None:
            self._assert_same_message(existing, item)
            return committed

        metadata: dict[str, object] = {
            "client_user_message_id": item.client_user_message_id,
            "source": item.source,
            "image_paths": list(item.image_paths),
        }
        conversation.append(
            Message(
                role="user",
                content=item.text,
                blocks=self._user_blocks(item),
                metadata={**metadata, "turn_id": turn_id},
            )
        )
        try:
            self._session_service.append_history_items(
                self._session_id,
                (
                    HistoryItem(
                        id=history_id,
                        thread_id=self._session_id,
                        turn_id=turn_id,
                        type=HistoryItemType.USER_MESSAGE,
                        text=item.text,
                        metadata=metadata,
                    ),
                ),
            )
        except Exception:
            conversation.messages.pop()
            raise

        self._append_turn_item(
            turn_id=turn_id,
            turn_items=turn_items,
            item=TurnItem(
                type=TurnItemType.USER_MESSAGE,
                text=item.text,
                metadata={**metadata, "history_committed": True},
            ),
        )
        self._emit_lifecycle(
            turn_id=turn_id,
            history_id=history_id,
            item=item,
            stream_sink=stream_sink,
        )
        return committed

    def _history_item(self, history_id: str) -> HistoryItem | None:
        return next(
            (
                item
                for item in self._session_service.load_history_items(self._session_id)
                if item.id == history_id
            ),
            None,
        )

    @staticmethod
    def _assert_same_message(
        existing: HistoryItem,
        item: UserMessageInput,
    ) -> None:
        metadata = existing.metadata
        existing_images = metadata.get("image_paths", [])
        if (
            existing.type is not HistoryItemType.USER_MESSAGE
            or existing.text != item.text
            or metadata.get("source") != item.source
            or tuple(existing_images) != item.image_paths
        ):
            raise UserMessageIdConflictError(item.client_user_message_id)

    @staticmethod
    def _user_blocks(item: UserMessageInput) -> tuple[RuntimeBlock, ...]:
        blocks = [RuntimeBlock(type="text", text=item.text)]
        blocks.extend(local_image_block(path) for path in item.image_paths)
        return tuple(blocks)

    @staticmethod
    def _emit_lifecycle(
        *,
        turn_id: str,
        history_id: str,
        item: UserMessageInput,
        stream_sink: Callable[[RuntimeStreamEvent], None] | None,
    ) -> None:
        if stream_sink is None:
            return
        payload: dict[str, object] = {
            "id": history_id,
            "type": "user_message",
            "client_user_message_id": item.client_user_message_id,
            "content": item.text,
            "source": item.source,
        }
        metadata: dict[str, object] = {"turn_id": turn_id, "item": payload}
        stream_sink(RuntimeStreamEvent(kind="item_started", metadata=metadata))
        stream_sink(RuntimeStreamEvent(kind="item_completed", metadata=metadata))


__all__ = ["CommittedUserMessage", "UserMessageLifecycle"]
