from __future__ import annotations

from dataclasses import dataclass

from mycli.domain.conversation import Conversation, Message


@dataclass(slots=True, frozen=True)
class ConversationBranch:
    session_id: str
    parent_id: str | None
    fork_point: int | None
    message_count: int


class ConversationTree:
    def __init__(self, conversations: tuple[Conversation, ...] = ()) -> None:
        self._conversations = {conversation.session_id: conversation for conversation in conversations}

    def add(self, conversation: Conversation) -> None:
        self._conversations[conversation.session_id] = conversation

    def get(self, session_id: str) -> Conversation | None:
        return self._conversations.get(session_id)

    def require(self, session_id: str) -> Conversation:
        conversation = self.get(session_id)
        if conversation is None:
            raise KeyError(f"Conversation does not exist: {session_id}")
        return conversation

    def branches(self) -> tuple[ConversationBranch, ...]:
        return tuple(
            ConversationBranch(
                session_id=conversation.session_id,
                parent_id=conversation.parent_id,
                fork_point=conversation.fork_point,
                message_count=len(conversation.messages),
            )
            for conversation in sorted(
                self._conversations.values(),
                key=lambda item: (item.parent_id is not None, item.session_id),
            )
        )

    def children(self, session_id: str) -> tuple[Conversation, ...]:
        return tuple(
            conversation
            for conversation in self._conversations.values()
            if conversation.parent_id == session_id
        )

    def path_to_root(self, session_id: str) -> tuple[Conversation, ...]:
        path: list[Conversation] = []
        seen: set[str] = set()
        current = self.require(session_id)
        while True:
            if current.session_id in seen:
                raise ValueError(f"Conversation tree contains a cycle at {current.session_id}.")
            seen.add(current.session_id)
            path.append(current)
            if current.parent_id is None:
                return tuple(reversed(path))
            current = self.require(current.parent_id)

    def resume(self, session_id: str) -> Conversation:
        source = self.require(session_id)
        return Conversation(
            session_id=source.session_id,
            parent_id=source.parent_id,
            fork_point=source.fork_point,
            messages=list(source.messages),
        )

    def rewind(self, session_id: str, fork_point: int) -> Conversation:
        source = self.require(session_id)
        rewound = source.rewind(fork_point)
        self.add(rewound)
        return rewound

    def fork(
        self,
        source_session_id: str,
        new_session_id: str,
        fork_point: int | None = None,
    ) -> Conversation:
        if new_session_id in self._conversations:
            raise ValueError(f"Conversation already exists: {new_session_id}")
        source = self.require(source_session_id)
        forked = source.fork(new_session_id, fork_point)
        self.add(forked)
        return forked

    @staticmethod
    def messages_until(conversation: Conversation, fork_point: int) -> tuple[Message, ...]:
        if fork_point < 0 or fork_point > len(conversation.messages):
            raise ValueError("fork_point must be within the conversation message range.")
        return tuple(conversation.messages[:fork_point])
