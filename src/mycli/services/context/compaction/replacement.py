from __future__ import annotations

from dataclasses import dataclass

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import RuntimeBlock
from mycli.services.context.token_counter import TokenCounter


_EXCLUDED_ASSISTANT_METADATA = (
    "compaction",
    "compaction_continuation",
    "interrupted",
)


@dataclass(frozen=True, slots=True)
class CompactionSelection:
    removed_prefix: tuple[Message, ...]
    exact_tail: tuple[Message, ...]
    retained_turns: int


@dataclass(frozen=True, slots=True)
class _CompletedTurn:
    start_index: int
    user: Message
    assistant: Message


class CompactionReplacementBuilder:
    def __init__(
        self,
        *,
        tail_turns: int = 2,
        tail_max_tokens: int,
        token_counter: TokenCounter | None = None,
    ) -> None:
        if tail_turns < 0:
            raise ValueError("tail_turns must be non-negative")
        if tail_max_tokens < 0:
            raise ValueError("tail_max_tokens must be non-negative")
        self._tail_turns = tail_turns
        self._tail_max_tokens = tail_max_tokens
        self._token_counter = token_counter or TokenCounter()

    def select(self, conversation: Conversation) -> CompactionSelection:
        completed_turns = self._completed_turns(conversation.messages)
        retained = completed_turns[-self._tail_turns :] if self._tail_turns else []

        while len(retained) > 1 and self._count_turns(retained) > self._tail_max_tokens:
            retained.pop(0)

        first_retained_index = retained[0].start_index if retained else len(conversation.messages)
        exact_tail = tuple(
            message
            for turn in retained
            for message in (turn.user, turn.assistant)
        )
        return CompactionSelection(
            removed_prefix=tuple(conversation.messages[:first_retained_index]),
            exact_tail=exact_tail,
            retained_turns=len(retained),
        )

    def build(
        self,
        *,
        conversation: Conversation,
        selection: CompactionSelection,
        summary: str,
    ) -> Conversation:
        normalized_summary = summary.strip()
        if not normalized_summary:
            raise ValueError("summary must not be empty")
        summary_message = Message(
            role="user",
            content=f"[compact-summary]\n{normalized_summary}",
            metadata={"compaction": True},
        )
        return Conversation(
            session_id=conversation.session_id,
            parent_id=conversation.parent_id,
            fork_point=conversation.fork_point,
            messages=[summary_message, *selection.exact_tail],
        )

    def _completed_turns(self, messages: list[Message]) -> list[_CompletedTurn]:
        user_indexes = [index for index, message in enumerate(messages) if message.role == "user"]
        completed: list[_CompletedTurn] = []
        for offset, start_index in enumerate(user_indexes):
            end_index = user_indexes[offset + 1] if offset + 1 < len(user_indexes) else len(messages)
            final_assistant = next(
                (
                    message
                    for message in reversed(messages[start_index + 1 : end_index])
                    if self._is_final_assistant(message)
                ),
                None,
            )
            if final_assistant is None:
                continue
            completed.append(
                _CompletedTurn(
                    start_index=start_index,
                    user=self._clean_user(messages[start_index]),
                    assistant=self._clean_assistant(final_assistant),
                )
            )
        return completed

    def _count_turns(self, turns: list[_CompletedTurn]) -> int:
        return sum(
            self._token_counter.count_message(message)
            for turn in turns
            for message in (turn.user, turn.assistant)
        )

    @staticmethod
    def _is_final_assistant(message: Message) -> bool:
        return (
            message.role == "assistant"
            and bool(message.content.strip())
            and not message.tool_calls
            and not any(message.metadata.get(key) for key in _EXCLUDED_ASSISTANT_METADATA)
        )

    @staticmethod
    def _clean_user(message: Message) -> Message:
        return Message(
            role="user",
            content=message.content,
            blocks=message.blocks,
            metadata=dict(message.metadata),
        )

    @staticmethod
    def _clean_assistant(message: Message) -> Message:
        content = message.content.strip()
        return Message(
            role="assistant",
            content=content,
            blocks=(RuntimeBlock(type="text", text=content),),
            metadata=dict(message.metadata),
        )


__all__ = [
    "CompactionReplacementBuilder",
    "CompactionSelection",
]
