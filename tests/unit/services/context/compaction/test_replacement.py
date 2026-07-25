from __future__ import annotations

from mycli.domain.conversation import Conversation, Message
from mycli.domain.runtime import RuntimeBlock
from mycli.domain.tooling.calls import ToolCall
from mycli.services.context.compaction.replacement import CompactionReplacementBuilder


def _user(text: str, turn_id: str) -> Message:
    return Message(role="user", content=text, metadata={"turn_id": turn_id})


def _assistant(text: str) -> Message:
    return Message(
        role="assistant",
        content=text,
        blocks=(RuntimeBlock(type="text", text=text),),
    )


def _tool_turn(turn_id: str, request: str, answer: str) -> list[Message]:
    call_id = f"call_{turn_id}"
    return [
        _user(request, turn_id),
        Message(
            role="assistant",
            content="",
            tool_calls=(
                ToolCall(
                    name="Read",
                    arguments={"file_path": "README.md"},
                    reason="inspect",
                    call_id=call_id,
                ),
            ),
            blocks=(
                RuntimeBlock(type="text", text="I will inspect it."),
                RuntimeBlock(
                    type="tool_call",
                    tool_name="Read",
                    tool_arguments={"file_path": "README.md"},
                    call_id=call_id,
                ),
            ),
        ),
        Message(role="tool", content="large tool output", tool_call_id=call_id),
        _assistant(answer),
    ]


def test_replacement_keeps_summary_and_two_final_turn_answers() -> None:
    conversation = Conversation(
        session_id="demo",
        messages=[
            *_tool_turn("turn_1", "first request", "first answer"),
            *_tool_turn("turn_2", "second request", "second answer"),
            *_tool_turn("turn_3", "third request", "third answer"),
        ],
    )
    builder = CompactionReplacementBuilder(tail_turns=2, tail_max_tokens=2_000)

    selection = builder.select(conversation)
    replacement = builder.build(
        conversation=conversation,
        selection=selection,
        summary="Earlier work was summarized.",
    )

    assert selection.retained_turns == 2
    assert [message.content for message in selection.removed_prefix] == [
        "first request",
        "",
        "large tool output",
        "first answer",
    ]
    assert [(message.role, message.content) for message in selection.exact_tail] == [
        ("user", "second request"),
        ("assistant", "second answer"),
        ("user", "third request"),
        ("assistant", "third answer"),
    ]
    assert [(message.role, message.content) for message in replacement.messages] == [
        ("user", "[compact-summary]\nEarlier work was summarized."),
        ("user", "second request"),
        ("assistant", "second answer"),
        ("user", "third request"),
        ("assistant", "third answer"),
    ]
    assert replacement.messages[0].metadata["compaction"] is True
    assert all(not message.tool_calls for message in replacement.messages)
    assert all(message.response_id is None for message in replacement.messages)


def test_replacement_excludes_turn_without_final_assistant_answer() -> None:
    conversation = Conversation(
        session_id="demo",
        messages=[
            *_tool_turn("turn_1", "completed request", "completed answer"),
            _user("interrupted request", "turn_2"),
            Message(
                role="assistant",
                content="partial preface",
                metadata={"interrupted": True},
            ),
        ],
    )

    selection = CompactionReplacementBuilder(
        tail_turns=2,
        tail_max_tokens=2_000,
    ).select(conversation)

    assert [(message.role, message.content) for message in selection.exact_tail] == [
        ("user", "completed request"),
        ("assistant", "completed answer"),
    ]
    assert all("interrupted" not in message.content for message in selection.exact_tail)


def test_replacement_evicts_oldest_exact_turn_when_tail_budget_is_exceeded() -> None:
    conversation = Conversation(
        session_id="demo",
        messages=[
            _user("older " * 80, "turn_1"),
            _assistant("older answer " * 80),
            _user("new request", "turn_2"),
            _assistant("new answer"),
        ],
    )

    selection = CompactionReplacementBuilder(
        tail_turns=2,
        tail_max_tokens=20,
    ).select(conversation)

    assert selection.retained_turns == 1
    assert [(message.role, message.content) for message in selection.exact_tail] == [
        ("user", "new request"),
        ("assistant", "new answer"),
    ]

