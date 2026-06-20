from __future__ import annotations

from mycli.application.runtime.message_builder import (
    build_legacy_messages,
    build_runtime_items,
)
from mycli.domain.conversation import Message
from mycli.domain.runtime import (
    InstructionContract,
    InstructionFragment,
    RuntimeBlock,
)
from mycli.domain.tools import ToolCall


def test_build_runtime_items_preserves_structured_tool_calls_and_outputs() -> None:
    contract = InstructionContract(
        base_instructions="base",
        developer_sections=(
            InstructionFragment(kind="runtime_policy", title="Policy", content="policy"),
        ),
        contextual_user_sections=(
            InstructionFragment(kind="memory", title="Memory", content="memory"),
        ),
        assistant_scaffold="scaffold",
        conversation_messages=(
            Message(role="user", content="inspect"),
            Message(
                role="assistant",
                content="",
                tool_calls=(
                    ToolCall(
                        name="read_file",
                        arguments={"path": "README.md"},
                        reason="inspect file",
                        call_id="call_1",
                    ),
                ),
            ),
            Message(role="tool", content="contents", tool_call_id="call_1"),
        ),
    )

    items = build_runtime_items(contract=contract)

    assert [item.role for item in items] == [
        "system",
        "developer",
        "user",
        "assistant",
        "user",
        "assistant",
        "tool",
    ]
    assert items[5].blocks == (
        RuntimeBlock(
            type="tool_call",
            tool_name="read_file",
            tool_arguments={"path": "README.md"},
            call_id="call_1",
        ),
    )
    assert items[6].blocks == (
        RuntimeBlock(type="tool_result", text="contents", call_id="call_1"),
    )


def test_build_runtime_items_does_not_inject_legacy_react_scaffold() -> None:
    items = build_runtime_items(
        contract=InstructionContract(base_instructions="base")
    )

    assert [item.role for item in items] == ["system"]


def test_build_legacy_messages_merges_runtime_block_metadata() -> None:
    contract = InstructionContract(
        base_instructions="base",
        assistant_scaffold="scaffold",
        conversation_messages=(
            Message(
                role="assistant",
                content="answer",
                blocks=(
                    RuntimeBlock(
                        type="text",
                        text="answer",
                        metadata={"provider": {"id": "resp_1"}, "stable": True},
                    ),
                    RuntimeBlock(
                        type="reasoning",
                        text="reasoning",
                        metadata={"provider": {"reasoning_id": "rs_1"}},
                    ),
                ),
            ),
        ),
    )

    messages = build_legacy_messages(contract=contract)

    assert messages[-1].role == "assistant"
    assert messages[-1].content == "answer"
    assert messages[-1].metadata == {
        "provider": {"id": "resp_1", "reasoning_id": "rs_1"},
        "stable": True,
    }


def test_build_legacy_messages_does_not_inject_legacy_react_scaffold() -> None:
    messages = build_legacy_messages(
        contract=InstructionContract(base_instructions="base")
    )

    assert [(message.role, message.content) for message in messages] == [
        ("system", "base")
    ]
