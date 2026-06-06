from __future__ import annotations

from mycli.domain.tools import ToolCall
from mycli.llms.adapters.anthropic_messages_adapter import (
    AnthropicMessagesModelAdapter,
)
from mycli.llms.adapters.base import (
    ModelMessage,
    ModelToolDefinition,
    ModelToolParameter,
)
from mycli.domain.runtime.blocks import RuntimeBlock, RuntimeItem


class FakeAnthropicMessagesClient:
    def __init__(self, payload: dict[str, object]) -> None:
        self.payload = payload
        self.captured_system: object | None = None
        self.captured_messages: list[dict[str, object]] = []
        self.captured_tools: list[dict[str, object]] = []
        self.thinking_config: tuple[bool, object] | None = None

    def set_thinking_config(self, *, enabled: bool, effort: object) -> None:
        self.thinking_config = (enabled, effort)

    def create_message(
        self,
        *,
        system: object | None,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> dict[str, object]:
        self.captured_system = system
        self.captured_messages = messages
        self.captured_tools = tools
        return self.payload


class FakeStreamingAnthropicMessagesClient(FakeAnthropicMessagesClient):
    def stream_message(self, *, system, messages, tools):
        self.captured_system = system
        self.captured_messages = messages
        self.captured_tools = tools
        yield {"type": "reasoning", "text": "Need a concise answer."}
        yield {"type": "text_delta", "text": "anthropic "}
        yield {"type": "text_delta", "text": "ok"}
        yield {
            "type": "completed",
            "response_id": "msg_stream_1",
            "metadata": {"usage": {"input_tokens": 9, "output_tokens": 2}},
        }


def test_anthropic_adapter_stream_turn_uses_client_stream_message() -> None:
    client = FakeStreamingAnthropicMessagesClient({"id": "unused", "content": []})
    adapter = AnthropicMessagesModelAdapter(client=client)

    events = list(
        adapter.stream_turn(
            items=[
                RuntimeItem(
                    role="user",
                    blocks=(RuntimeBlock(type="text", text="Say ok."),),
                )
            ],
            tools=[],
        )
    )

    assert [event["type"] for event in events] == [
        "reasoning",
        "text_delta",
        "text_delta",
        "completed",
    ]
    assert client.captured_messages == [
        {"role": "user", "content": [{"type": "text", "text": "Say ok."}]}
    ]


def test_anthropic_adapter_serializes_system_developer_messages_and_tools() -> None:
    client = FakeAnthropicMessagesClient(
        {
            "id": "msg_123",
            "role": "assistant",
            "content": [{"type": "text", "text": "Ready."}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 10, "output_tokens": 3},
        }
    )
    adapter = AnthropicMessagesModelAdapter(client=client)

    result = adapter.next_turn(
        items=[
            RuntimeItem(
                role="system",
                blocks=(RuntimeBlock(type="text", text="System rules."),),
            ),
            RuntimeItem(
                role="developer",
                blocks=(RuntimeBlock(type="text", text="Developer rules."),),
            ),
            RuntimeItem(
                role="user",
                blocks=(RuntimeBlock(type="text", text="Read README."),),
            ),
        ],
        tools=[
            ModelToolDefinition(
                name="read_file",
                description="Read a file",
                parameters=(
                    ModelToolParameter(
                        name="path",
                        type="string",
                        required=True,
                        description="Path to read",
                    ),
                ),
            ),
        ],
    )

    assert client.captured_system == "System rules.\n\nDeveloper rules."
    assert client.captured_messages == [
        {
            "role": "user",
            "content": [{"type": "text", "text": "Read README."}],
        }
    ]
    assert client.captured_tools == [
        {
            "name": "read_file",
            "description": "Read a file",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to read",
                    }
                },
                "required": ["path"],
                "additionalProperties": False,
            },
        }
    ]
    assert result.done is True
    assert result.response_id == "msg_123"
    assert result.metadata == {"usage": {"input_tokens": 10, "output_tokens": 3}}
    assert result.items[0].blocks[0].text == "Ready."


def test_anthropic_adapter_adds_wire_only_cache_control_breakpoints() -> None:
    client = FakeAnthropicMessagesClient(
        {
            "id": "msg_123",
            "role": "assistant",
            "content": [{"type": "text", "text": "Ready."}],
            "stop_reason": "end_turn",
        }
    )
    adapter = AnthropicMessagesModelAdapter(client=client)
    system_block = RuntimeBlock(type="text", text="System rules.")
    dynamic_block = RuntimeBlock(type="text", text="Dynamic context.")
    items = [
        RuntimeItem(
            role="system",
            blocks=(system_block,),
            metadata={
                "provider_request_policy": {
                    "anthropic_cache_control_breakpoints": ("system_static",)
                }
            },
        ),
        RuntimeItem(
            role="user",
            blocks=(dynamic_block,),
            metadata={
                "provider_request_policy": {
                    "anthropic_cache_control_breakpoints": ("dynamic_boundary",)
                }
            },
        ),
    ]

    adapter.next_turn(items=items, tools=[])

    assert client.captured_system == [
        {
            "type": "text",
            "text": "System rules.",
            "cache_control": {"type": "ephemeral"},
        }
    ]
    assert client.captured_messages == [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "Dynamic context.",
                    "cache_control": {"type": "ephemeral"},
                }
            ],
        }
    ]
    assert "cache_control" not in system_block.metadata
    assert "cache_control" not in dynamic_block.metadata


def test_anthropic_adapter_serializes_prior_tool_use_and_tool_result() -> None:
    client = FakeAnthropicMessagesClient(
        {
            "id": "msg_124",
            "role": "assistant",
            "content": [{"type": "text", "text": "The README says hello."}],
            "stop_reason": "end_turn",
        }
    )
    adapter = AnthropicMessagesModelAdapter(client=client)

    adapter.next_turn(
        items=[
            RuntimeItem(
                role="assistant",
                blocks=(
                    RuntimeBlock(
                        type="tool_call",
                        tool_name="read_file",
                        tool_arguments={"path": "README.md"},
                        call_id="toolu_123",
                        provider_id="toolu_123",
                    ),
                ),
            ),
            RuntimeItem(
                role="tool",
                blocks=(
                    RuntimeBlock(
                        type="tool_result",
                        text="README content",
                        call_id="toolu_123",
                    ),
                ),
            ),
        ],
        tools=[],
    )

    assert client.captured_messages == [
        {
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_123",
                    "name": "read_file",
                    "input": {"path": "README.md"},
                }
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_123",
                    "content": "README content",
                }
            ],
        },
    ]


def test_anthropic_adapter_maps_tool_use_to_runtime_tool_call() -> None:
    client = FakeAnthropicMessagesClient(
        {
            "id": "msg_tool",
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_456",
                    "name": "search_text",
                    "input": {"pattern": "Anthropic"},
                }
            ],
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 12, "output_tokens": 7},
        }
    )
    adapter = AnthropicMessagesModelAdapter(client=client)

    result = adapter.next_turn(
        items=[
            RuntimeItem(
                role="user",
                blocks=(RuntimeBlock(type="text", text="Find Anthropic."),),
            )
        ],
        tools=[],
    )

    block = result.items[0].blocks[0]
    assert result.done is False
    assert block.type == "tool_call"
    assert block.tool_name == "search_text"
    assert block.tool_arguments == {"pattern": "Anthropic"}
    assert block.call_id == "toolu_456"
    assert block.provider_id == "toolu_456"
    assert block.source == "native"
    assert block.metadata["anthropic"] == {
        "type": "tool_use",
        "id": "toolu_456",
        "name": "search_text",
        "input": {"pattern": "Anthropic"},
    }


def test_anthropic_adapter_maps_thinking_to_reasoning_block() -> None:
    client = FakeAnthropicMessagesClient(
        {
            "id": "msg_thinking",
            "role": "assistant",
            "content": [
                {
                    "type": "thinking",
                    "thinking": "I should inspect the repository first.",
                    "signature": "sig_123",
                },
                {"type": "text", "text": "I will inspect the repository."},
            ],
            "stop_reason": "end_turn",
        }
    )
    adapter = AnthropicMessagesModelAdapter(client=client)

    result = adapter.next_turn(
        items=[
            RuntimeItem(
                role="user",
                blocks=(RuntimeBlock(type="text", text="Analyze this repo."),),
            )
        ],
        tools=[],
    )

    reasoning_block = result.items[0].blocks[0]
    text_block = result.items[0].blocks[1]
    assert reasoning_block.type == "reasoning"
    assert reasoning_block.text == "I should inspect the repository first."
    assert reasoning_block.metadata["anthropic"] == {
        "type": "thinking",
        "thinking": "I should inspect the repository first.",
        "signature": "sig_123",
    }
    assert text_block.type == "text"
    assert text_block.text == "I will inspect the repository."


def test_anthropic_adapter_next_action_maps_first_tool_call() -> None:
    client = FakeAnthropicMessagesClient(
        {
            "id": "msg_action",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_action",
                    "name": "read_file",
                    "input": {"path": "README.md"},
                }
            ],
        }
    )
    adapter = AnthropicMessagesModelAdapter(client=client)

    action = adapter.next_action(
        messages=[
            ModelMessage(
                role="assistant",
                content="",
                tool_calls=(
                    ToolCall(
                        name="search_text",
                        arguments={"pattern": "provider"},
                        reason="model requested tool",
                        call_id="toolu_prior",
                    ),
                ),
            )
        ],
        tools=[],
    )

    assert client.captured_messages == [
        {
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_prior",
                    "name": "search_text",
                    "input": {"pattern": "provider"},
                }
            ],
        }
    ]
    assert action.tool_call is not None
    assert action.tool_call.name == "read_file"
    assert action.tool_call.arguments == {"path": "README.md"}
    assert action.tool_call.call_id == "toolu_action"
    assert action.done is False


def test_anthropic_adapter_forwards_thinking_config() -> None:
    client = FakeAnthropicMessagesClient(
        {"id": "msg_1", "content": [{"type": "text", "text": "ok"}]}
    )
    adapter = AnthropicMessagesModelAdapter(client=client)

    adapter.set_thinking_config(enabled=True, effort="high")

    assert client.thinking_config == (True, "high")


def test_anthropic_adapter_round_trips_tool_call_and_result() -> None:
    client = FakeAnthropicMessagesClient(
        {
            "id": "msg_tool_result",
            "role": "assistant",
            "content": [{"type": "text", "text": "README content received."}],
            "stop_reason": "end_turn",
        }
    )
    adapter = AnthropicMessagesModelAdapter(client=client)

    first_result = adapter.next_turn(
        items=[
            RuntimeItem(
                role="user",
                blocks=(RuntimeBlock(type="text", text="Read README.md"),),
            )
        ],
        tools=[
            ModelToolDefinition(
                name="read_file",
                description="Read a file",
                parameters=(
                    ModelToolParameter(name="path", type="string", required=True),
                ),
            )
        ],
    )

    assert first_result.done is True

    adapter.next_turn(
        items=[
            RuntimeItem(
                role="assistant",
                blocks=(
                    RuntimeBlock(
                        type="tool_call",
                        tool_name="read_file",
                        tool_arguments={"path": "README.md"},
                        call_id="toolu_readme",
                    ),
                ),
            ),
            RuntimeItem(
                role="tool",
                blocks=(
                    RuntimeBlock(
                        type="tool_result",
                        text="README.md says hello",
                        call_id="toolu_readme",
                    ),
                ),
            ),
        ],
        tools=[],
    )

    assert client.captured_messages[-2:] == [
        {
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_readme",
                    "name": "read_file",
                    "input": {"path": "README.md"},
                }
            ],
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_readme",
                    "content": "README.md says hello",
                }
            ],
        },
    ]


def test_anthropic_adapter_replays_raw_thinking_metadata() -> None:
    client = FakeAnthropicMessagesClient(
        {"id": "msg_1", "content": [{"type": "text", "text": "ok"}]}
    )
    adapter = AnthropicMessagesModelAdapter(client=client)

    adapter.next_turn(
        items=[
            RuntimeItem(
                role="assistant",
                blocks=(
                    RuntimeBlock(
                        type="reasoning",
                        text="I should inspect files.",
                        metadata={
                            "anthropic": {
                                "type": "thinking",
                                "thinking": "I should inspect files.",
                                "signature": "sig_keep",
                            }
                        },
                    ),
                ),
            )
        ],
        tools=[],
    )

    assert client.captured_messages == [
        {
            "role": "assistant",
            "content": [
                {
                    "type": "thinking",
                    "thinking": "I should inspect files.",
                    "signature": "sig_keep",
                }
            ],
        }
    ]
