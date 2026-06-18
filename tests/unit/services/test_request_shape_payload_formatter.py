from __future__ import annotations

from mycli.domain.runtime import ProviderMessageShape, ProviderRuntimeItemShape, RequestShape, RuntimeBlock
from mycli.domain.tools import ToolCall
from mycli.application.runtime.request import RequestShapePayloadFormatter


def test_request_shape_payload_formatter_builds_legacy_messages_in_shape_order() -> None:
    shape = RequestShape(
        provider="deepseek",
        protocol="chat_completions",
        model="deepseek-v4-flash",
        stable_system="stable",
        provider_messages=(
            ProviderMessageShape(role="system", content="stable"),
            ProviderMessageShape(role="developer", content="tools"),
            ProviderMessageShape(role="assistant", content="replay"),
            ProviderMessageShape(role="user", content="Current user request: fix cache"),
            ProviderMessageShape(role="user", content="volatile context"),
        ),
    )

    messages = RequestShapePayloadFormatter().legacy_messages(shape)

    assert [message.role for message in messages] == [
        "system",
        "developer",
        "assistant",
        "user",
        "user",
    ]
    assert [message.content for message in messages] == [
        "stable",
        "tools",
        "replay",
        "Current user request: fix cache",
        "volatile context",
    ]


def test_request_shape_payload_formatter_preserves_legacy_tool_replay_metadata() -> None:
    tool_call = ToolCall(
        name="read_file",
        arguments={"path": "README.md"},
        reason="inspect",
        call_id="call_read_1",
    )
    shape = RequestShape(
        provider="deepseek",
        protocol="chat_completions",
        model="deepseek-v4-flash",
        stable_system="stable",
        provider_messages=(
            ProviderMessageShape(
                role="assistant",
                content='[{"name":"read_file"}]',
                metadata={
                    "legacy_content": "",
                    "tool_calls": (tool_call,),
                    "model_metadata": {"deepseek": {"reasoning_content": "inspect first"}},
                },
            ),
            ProviderMessageShape(
                role="tool",
                content="Tool read_file: README",
                metadata={
                    "legacy_content": "Tool read_file: README",
                    "tool_call_id": "call_read_1",
                },
            ),
        ),
    )

    messages = RequestShapePayloadFormatter().legacy_messages(shape)

    assert messages[0].content == ""
    assert messages[0].tool_calls == (tool_call,)
    assert messages[0].metadata == {"deepseek": {"reasoning_content": "inspect first"}}
    assert messages[1].tool_call_id == "call_read_1"


def test_request_shape_payload_formatter_preserves_model_visible_tool_runtime_reminder() -> None:
    shape = RequestShape(
        provider="deepseek",
        protocol="chat_completions",
        model="deepseek-v4-flash",
        stable_system="stable",
        provider_messages=(
            ProviderMessageShape(
                role="tool",
                content=(
                    "README.md\n\n"
                    "<tool_runtime_reminder>\n"
                    "Runtime reminders: do not repeat ls\n"
                    "</tool_runtime_reminder>"
                ),
                metadata={"tool_call_id": "call_ls"},
            ),
        ),
        provider_runtime_items=(
            ProviderRuntimeItemShape(
                role="tool",
                blocks=(
                    RuntimeBlock(
                        type="tool_result",
                        text=(
                            "README.md\n\n"
                            "<tool_runtime_reminder>\n"
                            "Runtime reminders: do not repeat ls\n"
                            "</tool_runtime_reminder>"
                        ),
                        call_id="call_ls",
                    ),
                ),
            ),
        ),
    )

    messages = RequestShapePayloadFormatter().legacy_messages(shape)
    items = RequestShapePayloadFormatter().runtime_items(shape)

    assert messages[0].content.endswith("</tool_runtime_reminder>")
    assert messages[0].tool_call_id == "call_ls"
    assert items[0].blocks[0].text.endswith("</tool_runtime_reminder>")
    assert items[0].blocks[0].call_id == "call_ls"


def test_request_shape_payload_formatter_keeps_empty_assistant_tool_call_messages() -> None:
    tool_call = ToolCall(
        name="read_file",
        arguments={"path": "README.md"},
        reason="inspect",
        call_id="call_read_1",
    )
    shape = RequestShape(
        provider="deepseek",
        protocol="chat_completions",
        model="deepseek-v4-flash",
        stable_system="stable",
        provider_messages=(
            ProviderMessageShape(
                role="assistant",
                content="",
                metadata={
                    "tool_calls": (tool_call,),
                    "model_metadata": {
                        "deepseek": {"reasoning_content": "Need README."}
                    },
                },
            ),
        ),
    )

    messages = RequestShapePayloadFormatter().legacy_messages(shape)

    assert len(messages) == 1
    assert messages[0].content == ""
    assert messages[0].tool_calls == (tool_call,)
    assert messages[0].metadata == {"deepseek": {"reasoning_content": "Need README."}}


def test_request_shape_payload_formatter_builds_runtime_items_in_shape_order() -> None:
    shape = RequestShape(
        provider="qwen",
        protocol="responses",
        model="qwen3.6-plus",
        stable_system="stable",
        provider_runtime_items=(
            ProviderRuntimeItemShape(
                role="system",
                blocks=(RuntimeBlock(type="text", text="stable"),),
            ),
            ProviderRuntimeItemShape(
                role="user",
                blocks=(RuntimeBlock(type="text", text="Current user request: inspect"),),
            ),
            ProviderRuntimeItemShape(
                role="user",
                blocks=(RuntimeBlock(type="text", text="volatile context"),),
            ),
        ),
    )

    items = RequestShapePayloadFormatter().runtime_items(shape)

    assert [item.role for item in items] == ["system", "user", "user"]
    assert [item.blocks[0].text for item in items] == [
        "stable",
        "Current user request: inspect",
        "volatile context",
    ]


def test_request_shape_payload_formatter_preserves_runtime_item_metadata() -> None:
    shape = RequestShape(
        provider="anthropic",
        protocol="anthropic_messages",
        model="claude-test",
        stable_system="stable",
        provider_runtime_items=(
            ProviderRuntimeItemShape(
                role="system",
                blocks=(RuntimeBlock(type="text", text="stable"),),
                metadata={"cache_policy": {"breakpoint": "system_static"}},
            ),
        ),
    )

    items = RequestShapePayloadFormatter().runtime_items(shape)

    assert items[0].metadata == {"cache_policy": {"breakpoint": "system_static"}}
