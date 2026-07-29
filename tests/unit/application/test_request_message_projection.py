from __future__ import annotations

from mycli.application.runtime.request.message_projection import (
    RequestMessageProjector,
)
from mycli.domain.conversation import Message
from mycli.domain.runtime import RuntimeBlock
from mycli.domain.tooling.calls import ToolCall


def test_projector_preserves_structured_tool_calls_and_outputs() -> None:
    projector = RequestMessageProjector()
    call = ToolCall(
        name="read_file",
        arguments={"path": "README.md"},
        reason="inspect file",
        call_id="call_1",
    )

    assistant_blocks = projector.runtime_blocks_from_message(
        Message(role="assistant", content="", tool_calls=(call,))
    )
    tool_blocks = projector.runtime_blocks_from_message(
        Message(role="tool", content="contents", tool_call_id="call_1")
    )

    assert assistant_blocks == (
        RuntimeBlock(
            type="tool_call",
            tool_name="read_file",
            tool_arguments={"path": "README.md"},
            call_id="call_1",
        ),
    )
    assert tool_blocks == (
        RuntimeBlock(type="tool_result", text="contents", call_id="call_1"),
    )


def test_projector_merges_runtime_block_metadata() -> None:
    projector = RequestMessageProjector()
    message = Message(
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
    )

    assert projector.message_metadata_from_blocks(message) == {
        "provider": {"id": "resp_1", "reasoning_id": "rs_1"},
        "stable": True,
    }


def test_projector_keeps_image_paths_out_of_plain_metadata() -> None:
    image_block = RuntimeBlock(type="image", metadata={"path": "/tmp/screenshot.png"})
    message = Message(
        role="user",
        content="[image #1]",
        blocks=(RuntimeBlock(type="text", text="[image #1]"), image_block),
    )
    projector = RequestMessageProjector()

    assert projector.message_metadata_from_blocks(message) == {}
    assert projector.runtime_blocks_from_message(message) == (
        RuntimeBlock(type="text", text="[image #1]"),
        image_block,
    )
