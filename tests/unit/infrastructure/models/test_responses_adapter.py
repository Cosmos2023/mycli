import logging
from datetime import datetime, timezone
from pathlib import Path

import pytest

from mycli.domain.logging import ModelLogContext
from mycli.domain.model_events import ModelEvent, ModelEventType, ToolExecutionSource
from mycli.llms.adapters.base import (
    ModelToolDefinition,
    ModelToolParameter,
    ModelTurnResult,
    RuntimeBlock,
    RuntimeItem,
)
from mycli.llms.adapters.responses_adapter import ResponsesModelAdapter
from mycli.llms.clients.openai_chat import ModelResponseError
from mycli.schemas.responses_protocol import (
    ResponsesCompletedEvent,
    ResponsesInProgressEvent,
    ResponsesOutputTextDeltaEvent,
)
from mycli.utils.workspace_logger import WorkspaceLogService


def test_runtime_block_contract_supports_text_and_tool_call_blocks() -> None:
    text_block = RuntimeBlock(type="text", text="I will read the README.")
    tool_call_block = RuntimeBlock(
        type="tool_call",
        tool_name="read_file",
        tool_arguments={"path": "README.md"},
        call_id="call_readme_1",
    )
    item = RuntimeItem(role="assistant", blocks=(text_block, tool_call_block))
    result = ModelTurnResult(items=(item,), done=False, response_id="resp_123")

    assert result.items[0].blocks[0].type == "text"
    assert result.items[0].blocks[0].text == "I will read the README."
    assert result.items[0].blocks[1].type == "tool_call"
    assert result.items[0].blocks[1].call_id == "call_readme_1"


def test_runtime_block_tool_call_requires_tool_name_and_call_id() -> None:
    with pytest.raises(ValueError, match="tool_name"):
        RuntimeBlock(type="tool_call", call_id="call_missing_name")

    with pytest.raises(ValueError, match="call_id"):
        RuntimeBlock(type="tool_call", tool_name="read_file")


def test_runtime_block_text_requires_text_content() -> None:
    with pytest.raises(ValueError, match="text"):
        RuntimeBlock(type="text")


def test_runtime_block_image_requires_path_or_url() -> None:
    with pytest.raises(ValueError, match="image"):
        RuntimeBlock(type="image")


class FakeResponsesClient:
    def __init__(self, payload: dict[str, object]) -> None:
        self._payload = payload
        self.captured_input_items: list[dict[str, object]] = []
        self.captured_tools: list[dict[str, object]] = []
        self.captured_reasoning_effort: str | None = None
        self.captured_prompt_cache_key: str | None = None
        self.captured_instructions: str | None = None

    def create_response(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]],
        instructions: str | None = None,
        prompt_cache_key: str | None = None,
    ) -> dict[str, object]:
        self.captured_input_items = input_items
        self.captured_tools = tools
        self.captured_instructions = instructions
        self.captured_prompt_cache_key = prompt_cache_key
        return self._payload

    def set_reasoning_effort(self, reasoning_effort: str | None) -> None:
        self.captured_reasoning_effort = reasoning_effort

    def record_response_completion(
        self,
        *,
        response_id: str | None,
        response_output_items: list[dict[str, object]],
    ) -> None:
        self.recorded_response_id = response_id
        self.recorded_response_output_items = response_output_items


class FakeStreamingResponsesClient(FakeResponsesClient):
    def __init__(self, events: list[dict[str, object]]) -> None:
        super().__init__({})
        self._events = events

    def stream_response(
        self,
        *,
        input_items: list[dict[str, object]],
        tools: list[dict[str, object]],
        instructions: str | None = None,
    ):
        self.captured_input_items = input_items
        self.captured_tools = tools
        self.captured_instructions = instructions
        yield from self._events


def test_responses_adapter_next_turn_serializes_and_maps_provider_output() -> None:
    client = FakeResponsesClient(
        {
            "id": "resp_123",
            "output": [
                {
                    "id": "fc_001",
                    "type": "function_call",
                    "name": "list_directory",
                    "arguments": '{"path":"."}',
                    "call_id": "call_001",
                },
                {
                    "id": "msg_001",
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "I can inspect the repository for you.",
                        }
                    ],
                },
            ],
        }
    )
    adapter = ResponsesModelAdapter(client=client)

    result = adapter.next_turn(
        items=[
            RuntimeItem(role="user", blocks=(RuntimeBlock(type="text", text="inspect the repo"),)),
            RuntimeItem(
                role="assistant",
                blocks=(
                    RuntimeBlock(type="text", text="I will inspect the repository."),
                    RuntimeBlock(
                        type="tool_call",
                        tool_name="list_directory",
                        tool_arguments={"path": "."},
                        call_id="call_prev_1",
                    ),
                ),
            ),
            RuntimeItem(
                role="tool",
                blocks=(
                    RuntimeBlock(
                        type="tool_result",
                        text="README.md, src",
                        call_id="call_prev_1",
                    ),
                ),
            ),
        ],
        tools=[
            ModelToolDefinition(
                name="list_directory",
                description="List entries in a directory",
                parameters=(ModelToolParameter(name="path", type="string"),),
            )
        ],
    )

    assert client.captured_input_items == [
        {
            "role": "user",
            "content": [{"type": "input_text", "text": "inspect the repo"}],
        },
        {
            "role": "assistant",
            "content": [
                {
                    "type": "input_text",
                    "text": "I will inspect the repository.",
                }
            ],
        },
        {
            "type": "function_call",
            "name": "list_directory",
            "arguments": '{"path": "."}',
            "call_id": "call_prev_1",
        },
        {
            "type": "function_call_output",
            "call_id": "call_prev_1",
            "output": "README.md, src",
        },
    ]
    for serialized_item in client.captured_input_items:
        if "content" in serialized_item:
            assert all(
                content_item["type"] == "input_text"
                for content_item in serialized_item["content"]
            )
    assert client.captured_tools == [
        {
            "name": "list_directory",
            "description": "List entries in a directory",
            "parameters": [
                {
                    "name": "path",
                    "type": "string",
                    "required": True,
                    "description": None,
                }
            ],
        }
    ]
    assert result.response_id == "resp_123"
    assert result.done is False


def test_responses_adapter_serializes_local_image_blocks(tmp_path: Path) -> None:
    image_path = tmp_path / "tiny.png"
    image_path.write_bytes(
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
        b"\x1f\x15\xc4\x89"
    )
    client = FakeResponsesClient(
        {
            "id": "resp_123",
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "done"}],
                }
            ],
        }
    )
    adapter = ResponsesModelAdapter(client=client)

    adapter.next_turn(
        items=[
            RuntimeItem(
                role="user",
                blocks=(
                    RuntimeBlock(type="text", text="what is this?"),
                    RuntimeBlock(type="image", metadata={"path": str(image_path)}),
                ),
            )
        ],
        tools=[],
    )

    assert client.captured_input_items == [
        {
            "role": "user",
            "content": [
                {"type": "input_text", "text": "what is this?"},
                {
                    "type": "input_image",
                    "image_url": client.captured_input_items[0]["content"][1]["image_url"],
                },
            ],
        }
    ]
    image_url = client.captured_input_items[0]["content"][1]["image_url"]
    assert isinstance(image_url, str)
    assert image_url.startswith("data:image/png;base64,")


def test_responses_adapter_aggregates_model_events_into_turn_result() -> None:
    client = FakeResponsesClient({"id": "resp_123", "output": []})
    client.create_events = lambda **_: [
        ModelEvent.message_delta(text="I can inspect the repository."),
        ModelEvent.tool_call_requested(
            tool_name="list_directory",
            tool_arguments={"path": "."},
            call_id="call_001",
            source=ToolExecutionSource.NATIVE,
            provider_id="fc_001",
        ),
        ModelEvent(type=ModelEventType.TURN_COMPLETED, response_id="resp_123"),
    ]
    adapter = ResponsesModelAdapter(client=client)

    result = adapter.next_turn(
        items=[
            RuntimeItem(
                role="user",
                blocks=(RuntimeBlock(type="text", text="inspect the repo"),),
            )
        ],
        tools=[],
    )

    assert result.response_id == "resp_123"
    assert result.items[0].blocks[0].type == "text"
    assert result.items[0].blocks[1].type == "tool_call"


def test_responses_adapter_preserves_array_parameter_item_schema() -> None:
    client = FakeResponsesClient({"id": "resp_123", "output": []})
    adapter = ResponsesModelAdapter(client=client)

    adapter.next_turn(
        items=[RuntimeItem(role="user", blocks=(RuntimeBlock(type="text", text="record plan"),))],
        tools=[
            ModelToolDefinition(
                name="update_plan",
                description="Replace the active plan with a structured list of pending and in-progress steps.",
                parameters=(
                    ModelToolParameter(
                        name="items",
                        type="array",
                        items_schema={
                            "type": "object",
                            "properties": {
                                "status": {"type": "string"},
                                "description": {"type": "string"},
                            },
                            "required": ["status"],
                            "additionalProperties": False,
                        },
                    ),
                ),
            )
        ],
    )

    assert client.captured_tools == [
        {
            "name": "update_plan",
            "description": "Replace the active plan with a structured list of pending and in-progress steps.",
            "parameters": [
                {
                    "name": "items",
                    "type": "array",
                    "required": True,
                    "description": None,
                    "items_schema": {
                        "type": "object",
                        "properties": {
                            "status": {"type": "string"},
                            "description": {"type": "string"},
                        },
                        "required": ["status"],
                        "additionalProperties": False,
                    },
                }
            ],
        }
    ]


def test_responses_adapter_passes_prompt_cache_key_to_client() -> None:
    client = FakeResponsesClient({"id": "resp_123", "output": []})
    adapter = ResponsesModelAdapter(client=client)

    adapter.next_turn(
        items=[
            RuntimeItem(
                role="user",
                blocks=(RuntimeBlock(type="text", text="inspect"),),
                metadata={
                    "provider_request_policy": {
                        "prompt_cache_key": "mycli:openai:responses:stable"
                    }
                },
            )
        ],
        tools=[],
    )

    assert client.captured_prompt_cache_key == "mycli:openai:responses:stable"


def test_responses_adapter_passes_system_item_metadata_as_instructions() -> None:
    client = FakeResponsesClient({"id": "resp_123", "output": []})
    adapter = ResponsesModelAdapter(client=client)

    adapter.next_turn(
        items=[
            RuntimeItem(
                role="system",
                blocks=(),
                metadata={"wire_instructions": "You are mycli."},
            ),
            RuntimeItem(
                role="user",
                blocks=(RuntimeBlock(type="text", text="inspect"),),
            ),
        ],
        tools=[],
    )

    assert client.captured_instructions == "You are mycli."
    assert client.captured_input_items == [
        {
            "role": "user",
            "content": [{"type": "input_text", "text": "inspect"}],
        }
    ]


def test_responses_adapter_replays_same_issuer_reasoning_and_message_items() -> None:
    client = FakeResponsesClient({"id": "resp_123", "output": []})
    adapter = ResponsesModelAdapter(client=client)

    adapter.next_turn(
        items=[
            RuntimeItem(
                role="assistant",
                blocks=(RuntimeBlock(type="text", text="Visible answer."),),
                metadata={
                    "provider_state": {
                        "issuer": "openai_responses",
                        "codex_reasoning_items": [
                            {
                                "id": "rs_1",
                                "type": "reasoning",
                                "encrypted_content": "opaque",
                                "summary": [],
                                "status": "completed",
                                "_issuer_kind": "openai_responses",
                            }
                        ],
                        "codex_message_items": [
                            {
                                "id": "msg_1",
                                "type": "message",
                                "role": "assistant",
                                "status": "completed",
                                "content": [
                                    {
                                        "type": "output_text",
                                        "text": "Visible answer.",
                                    }
                                ],
                            }
                        ],
                    }
                },
            )
        ],
        tools=[],
    )

    assert client.captured_input_items[:2] == [
        {
            "id": "rs_1",
            "type": "reasoning",
            "encrypted_content": "opaque",
            "summary": [],
            "status": "completed",
        },
        {
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [
                {
                    "type": "output_text",
                    "text": "Visible answer.",
                }
            ],
        },
    ]


def test_responses_adapter_filters_foreign_issuer_reasoning_items() -> None:
    client = FakeResponsesClient({"id": "resp_123", "output": []})
    adapter = ResponsesModelAdapter(client=client)

    adapter.next_turn(
        items=[
            RuntimeItem(
                role="assistant",
                blocks=(RuntimeBlock(type="text", text="Visible answer."),),
                metadata={
                    "provider_state": {
                        "issuer": "other_responses",
                        "codex_reasoning_items": [
                            {
                                "id": "rs_foreign",
                                "type": "reasoning",
                                "encrypted_content": "foreign",
                                "_issuer_kind": "other_responses",
                            }
                        ],
                    }
                },
            )
        ],
        tools=[],
    )

    assert all(
        item.get("type") != "reasoning"
        for item in client.captured_input_items
        if isinstance(item, dict)
    )
    assert client.captured_input_items == [
        {
            "role": "assistant",
            "content": [{"type": "input_text", "text": "Visible answer."}],
        }
    ]


def test_responses_adapter_uses_deterministic_fallback_ids_for_replay_items() -> None:
    client = FakeResponsesClient({"id": "resp_123", "output": []})
    adapter = ResponsesModelAdapter(client=client)
    items = [
        RuntimeItem(
            role="assistant",
            blocks=(RuntimeBlock(type="text", text="Visible answer."),),
            metadata={
                "provider_state": {
                    "codex_message_items": [
                        {
                            "type": "message",
                            "role": "assistant",
                            "content": [
                                {
                                    "type": "output_text",
                                    "text": "Visible answer.",
                                }
                            ],
                        }
                    ],
                }
            },
        )
    ]

    adapter.next_turn(items=items, tools=[])
    first_id = client.captured_input_items[0]["id"]
    adapter.next_turn(items=items, tools=[])
    second_id = client.captured_input_items[0]["id"]

    assert first_id == second_id
    assert str(first_id).startswith("msg_")


def test_responses_adapter_serializes_tool_result_payload_metadata_to_wire_text() -> None:
    client = FakeResponsesClient({"id": "resp_123", "output": []})
    adapter = ResponsesModelAdapter(client=client)

    adapter.next_turn(
        items=[
            RuntimeItem(
                role="tool",
                blocks=(
                    RuntimeBlock(
                        type="tool_result",
                        text="README contents loaded",
                        call_id="call_read_1",
                        metadata={
                            "function_call_output_payload": {
                                "body": "README contents loaded",
                                "structured_content": [{"path": "README.md"}],
                                "success": True,
                            }
                        },
                    ),
                ),
            ),
        ],
        tools=[],
    )

    assert client.captured_input_items == [
        {
            "type": "function_call_output",
            "call_id": "call_read_1",
            "output": "README contents loaded",
        }
    ]


def test_responses_adapter_serializes_tool_result_content_items() -> None:
    client = FakeResponsesClient({"id": "resp_123", "output": []})
    adapter = ResponsesModelAdapter(client=client)

    adapter.next_turn(
        items=[
            RuntimeItem(
                role="tool",
                blocks=(
                    RuntimeBlock(
                        type="tool_result",
                        text="fallback",
                        call_id="call_image_1",
                        metadata={
                            "function_call_output_payload": {
                                "body": "fallback",
                                "content_items": [
                                    {"type": "input_text", "text": "image result"},
                                    {
                                        "type": "input_image",
                                        "image_url": "https://example.com/result.png",
                                        "detail": "high",
                                    },
                                ],
                                "structured_content": [],
                                "success": True,
                            }
                        },
                    ),
                ),
            ),
        ],
        tools=[],
    )

    assert client.captured_input_items == [
        {
            "type": "function_call_output",
            "call_id": "call_image_1",
            "output": [
                {"type": "input_text", "text": "image result"},
                {
                    "type": "input_image",
                    "image_url": "https://example.com/result.png",
                    "detail": "high",
                },
            ],
        }
    ]


def test_responses_adapter_forwards_reasoning_effort_to_client() -> None:
    client = FakeResponsesClient({"id": "resp_123", "output": []})
    adapter = ResponsesModelAdapter(client=client)

    adapter.set_reasoning_effort("low")

    assert client.captured_reasoning_effort == "low"


def test_responses_adapter_raises_controlled_error_for_malformed_function_call_item() -> None:
    client = FakeResponsesClient(
        {
            "id": "resp_123",
            "output": [
                {
                    "id": "fc_001",
                    "type": "function_call",
                    "arguments": "{}",
                    "call_id": "call_001",
                },
            ],
        }
    )
    adapter = ResponsesModelAdapter(client=client)

    with pytest.raises(ModelResponseError, match="missing required 'name'"):
        adapter.next_turn(
            items=[RuntimeItem(role="user", blocks=(RuntimeBlock(type="text", text="inspect the repo"),))],
            tools=[],
        )


def test_responses_adapter_stream_turn_maps_responses_stream_events() -> None:
    client = FakeStreamingResponsesClient(
        [
            {
                "type": "response.reasoning_summary_text.delta",
                "item_id": "rs_1",
                "delta": "Inspect pyproject first.",
            },
            {
                "type": "response.output_text.delta",
                "item_id": "msg_1",
                "delta": "Repository ",
            },
            {
                "type": "response.function_call_arguments.done",
                "item_id": "fc_1",
                "name": "read_file",
                "arguments": '{"path":"pyproject.toml"}',
                "call_id": "call_read_1",
            },
            {
                "type": "response.completed",
                "response": {
                    "id": "resp_123",
                    "status": "completed",
                    "usage": {"output_tokens": 42},
                },
            },
        ]
    )
    adapter = ResponsesModelAdapter(client=client)

    events = list(
        adapter.stream_turn(
            items=[RuntimeItem(role="user", blocks=(RuntimeBlock(type="text", text="inspect"),))],
            tools=[],
        )
    )

    assert events == [
        {"type": "reasoning", "text": "Inspect pyproject first."},
        {"type": "text_delta", "text": "Repository "},
        {
            "type": "tool_call",
            "block": RuntimeBlock(
                type="tool_call",
                tool_name="read_file",
                tool_arguments={"path": "pyproject.toml"},
                call_id="call_read_1",
                provider_id="fc_1",
                metadata={
                    "provider_item_type": "function_call",
                    "provider_event_type": "response.function_call_arguments.done",
                },
            ),
        },
        {
            "type": "completed",
            "response_id": "resp_123",
            "metadata": {
                "response_status": "completed",
                "usage": {"output_tokens": 42},
            },
        },
    ]


def test_responses_adapter_stream_turn_recovers_function_call_state_from_output_item_added() -> None:
    client = FakeStreamingResponsesClient(
        [
            {
                "type": "response.output_item.added",
                "output_index": 0,
                "item": {
                    "id": "fc_1",
                    "type": "function_call",
                    "name": "read_file",
                    "call_id": "call_read_1",
                    "arguments": "",
                },
            },
            {
                "type": "response.function_call_arguments.delta",
                "item_id": "fc_1",
                "output_index": 0,
                "delta": '{"path":"pyproject',
            },
            {
                "type": "response.function_call_arguments.done",
                "item_id": "fc_1",
                "output_index": 0,
                "arguments": '{"path":"pyproject.toml"}',
            },
            {
                "type": "response.completed",
                "response": {
                    "id": "resp_123",
                    "status": "completed",
                },
            },
        ]
    )
    adapter = ResponsesModelAdapter(client=client)

    events = list(
        adapter.stream_turn(
            items=[RuntimeItem(role="user", blocks=(RuntimeBlock(type="text", text="inspect"),))],
            tools=[],
        )
    )

    assert events == [
        {
            "type": "tool_call",
            "block": RuntimeBlock(
                type="tool_call",
                tool_name="read_file",
                tool_arguments={"path": "pyproject.toml"},
                call_id="call_read_1",
                provider_id="fc_1",
                metadata={
                    "provider_item_type": "function_call",
                    "provider_event_type": "response.function_call_arguments.done",
                },
            ),
        },
        {
            "type": "completed",
            "response_id": "resp_123",
            "metadata": {
                "response_status": "completed",
                "usage": None,
            },
        },
    ]


def test_responses_adapter_stream_turn_falls_back_to_item_id_when_call_id_is_missing() -> None:
    client = FakeStreamingResponsesClient(
        [
            {
                "type": "response.output_item.added",
                "output_index": 0,
                "item": {
                    "id": "fc_1",
                    "type": "function_call",
                    "name": "read_file",
                    "arguments": "",
                },
            },
            {
                "type": "response.function_call_arguments.done",
                "item_id": "fc_1",
                "output_index": 0,
                "arguments": '{"path":"pyproject.toml"}',
            },
        ]
    )
    adapter = ResponsesModelAdapter(client=client)

    events = list(
        adapter.stream_turn(
            items=[RuntimeItem(role="user", blocks=(RuntimeBlock(type="text", text="inspect"),))],
            tools=[],
        )
    )

    assert events == [
        {
            "type": "tool_call",
            "block": RuntimeBlock(
                type="tool_call",
                tool_name="read_file",
                tool_arguments={"path": "pyproject.toml"},
                call_id="fc_1",
                provider_id="fc_1",
                metadata={
                    "provider_item_type": "function_call",
                    "provider_event_type": "response.function_call_arguments.done",
                },
            ),
        }
    ]


def test_responses_adapter_stream_turn_ignores_duplicate_function_call_completion_events() -> None:
    client = FakeStreamingResponsesClient(
        [
            {
                "type": "response.output_item.added",
                "output_index": 0,
                "item": {
                    "id": "fc_1",
                    "type": "function_call",
                    "name": "read_file",
                    "call_id": "call_read_1",
                    "arguments": "",
                },
            },
            {
                "type": "response.function_call_arguments.done",
                "item_id": "fc_1",
                "output_index": 0,
                "arguments": '{"path":"pyproject.toml"}',
            },
            {
                "type": "response.output_item.done",
                "output_index": 0,
                "item": {
                    "id": "fc_1",
                    "type": "function_call",
                    "name": "read_file",
                    "call_id": "call_read_1",
                    "arguments": '{"path":"pyproject.toml"}',
                },
            },
        ]
    )
    adapter = ResponsesModelAdapter(client=client)

    events = list(
        adapter.stream_turn(
            items=[RuntimeItem(role="user", blocks=(RuntimeBlock(type="text", text="inspect"),))],
            tools=[],
        )
    )

    assert events == [
        {
            "type": "tool_call",
            "block": RuntimeBlock(
                type="tool_call",
                tool_name="read_file",
                tool_arguments={"path": "pyproject.toml"},
                call_id="call_read_1",
                provider_id="fc_1",
                metadata={
                    "provider_item_type": "function_call",
                    "provider_event_type": "response.function_call_arguments.done",
                },
            ),
        }
    ]


def test_responses_adapter_stream_turn_maps_mcp_call_completed_to_reasoning_event() -> None:
    client = FakeStreamingResponsesClient(
        [
            {
                "type": "response.mcp_call_arguments.delta",
                "item_id": "mcp_1",
                "delta": '{"path":"src/mycli"}',
            },
            {
                "type": "response.mcp_call.completed",
                "item_id": "mcp_1",
                "name": "list_directory",
                "arguments": '{"path":"src/mycli"}',
                "output": "Tool list_directory does not exists.",
            },
            {
                "type": "response.completed",
                "response": {
                    "id": "resp_123",
                    "status": "completed",
                },
            },
        ]
    )
    adapter = ResponsesModelAdapter(client=client)

    events = list(
        adapter.stream_turn(
            items=[RuntimeItem(role="user", blocks=(RuntimeBlock(type="text", text="inspect"),))],
            tools=[],
        )
    )

    assert events == [
        {
            "type": "reasoning",
            "text": "Provider MCP call list_directory completed: Tool list_directory does not exists.",
        },
        {
            "type": "completed",
            "response_id": "resp_123",
            "metadata": {
                "response_status": "completed",
                "usage": None,
            },
        },
    ]


def test_responses_adapter_stream_turn_ignores_content_part_added_without_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = FakeStreamingResponsesClient(
        [
            {
                "type": "response.content_part.added",
                "item_id": "msg_1",
                "output_index": 0,
                "content_index": 0,
                "part": {
                    "type": "output_text",
                    "text": "",
                },
            },
            {
                "type": "response.output_text.delta",
                "item_id": "msg_1",
                "delta": "hello",
            },
        ]
    )
    adapter = ResponsesModelAdapter(client=client)

    with caplog.at_level(logging.WARNING):
        events = list(
            adapter.stream_turn(
                items=[RuntimeItem(role="user", blocks=(RuntimeBlock(type="text", text="inspect"),))],
                tools=[],
            )
        )

    assert events == [{"type": "text_delta", "text": "hello"}]
    assert "response.content_part.added" not in caplog.text


def test_responses_adapter_stream_turn_ignores_empty_dict_events() -> None:
    client = FakeStreamingResponsesClient(
        [
            {},
            {
                "type": "response.output_text.delta",
                "item_id": "msg_1",
                "delta": "hello",
            },
            {
                "type": "response.completed",
                "response": {"id": "resp_123", "status": "completed"},
            },
        ]
    )
    adapter = ResponsesModelAdapter(client=client)

    events = list(
        adapter.stream_turn(
            items=[RuntimeItem(role="user", blocks=(RuntimeBlock(type="text", text="inspect"),))],
            tools=[],
        )
    )

    assert events == [
        {"type": "text_delta", "text": "hello"},
        {
            "type": "completed",
            "response_id": "resp_123",
            "metadata": {
                "response_status": "completed",
                "usage": None,
            },
        },
    ]


def test_responses_adapter_stream_turn_raises_on_response_failed_event() -> None:
    client = FakeStreamingResponsesClient(
        [
            {
                "type": "response.failed",
                "response": {
                    "id": "resp_failed_1",
                    "status": "failed",
                    "error": {
                        "message": "The content field is a required field.",
                        "code": "server_error",
                    },
                },
            }
        ]
    )
    adapter = ResponsesModelAdapter(client=client)

    with pytest.raises(ModelResponseError, match="The content field is a required field"):
        list(
            adapter.stream_turn(
                items=[RuntimeItem(role="user", blocks=(RuntimeBlock(type="text", text="inspect"),))],
                tools=[],
            )
        )


def test_responses_adapter_stream_turn_accepts_typed_stream_events() -> None:
    client = FakeStreamingResponsesClient(
        [
            ResponsesInProgressEvent(response_id="resp_123"),
            ResponsesOutputTextDeltaEvent(item_id="msg_1", delta="hello"),
            ResponsesCompletedEvent(
                response_id="resp_123",
                response_status="completed",
                usage=None,
            ),
        ]
    )
    adapter = ResponsesModelAdapter(client=client)

    events = list(
        adapter.stream_turn(
            items=[RuntimeItem(role="user", blocks=(RuntimeBlock(type="text", text="inspect"),))],
            tools=[],
        )
    )

    assert events == [
        {"type": "text_delta", "text": "hello"},
        {
            "type": "completed",
            "response_id": "resp_123",
            "metadata": {
                "response_status": "completed",
                "usage": None,
            },
        },
    ]


def test_responses_adapter_stream_turn_ignores_raw_in_progress_event() -> None:
    client = FakeStreamingResponsesClient(
        [
            {
                "type": "response.in_progress",
                "response": {"id": "resp_123", "status": "in_progress"},
            },
            {
                "type": "response.output_text.delta",
                "item_id": "msg_1",
                "delta": "hello",
            },
            {
                "type": "response.completed",
                "response": {"id": "resp_123", "status": "completed"},
            },
        ]
    )
    adapter = ResponsesModelAdapter(client=client)

    events = list(
        adapter.stream_turn(
            items=[RuntimeItem(role="user", blocks=(RuntimeBlock(type="text", text="inspect"),))],
            tools=[],
        )
    )

    assert events == [
        {"type": "text_delta", "text": "hello"},
        {
            "type": "completed",
            "response_id": "resp_123",
            "metadata": {
                "response_status": "completed",
                "usage": None,
            },
        },
    ]

def test_responses_adapter_rejects_message_items_without_supported_output_content() -> None:
    client = FakeResponsesClient(
        {
            "id": "resp_123",
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{}],
                }
            ],
        }
    )
    adapter = ResponsesModelAdapter(client=client)

    with pytest.raises(ModelResponseError, match="supported output_text"):
        adapter.next_turn(
            items=[RuntimeItem(role="user", blocks=(RuntimeBlock(type="text", text="inspect the repo"),))],
            tools=[],
        )


def test_responses_adapter_maps_reasoning_summary_to_reasoning_blocks_and_metadata() -> None:
    client = FakeResponsesClient(
        {
            "id": "resp_123",
            "status": "completed",
            "usage": {"total_tokens": 42},
            "output": [
                {
                    "id": "rs_1",
                    "type": "reasoning",
                    "status": "completed",
                    "summary": [
                        {"type": "summary_text", "text": "I should inspect pyproject.toml first."}
                    ],
                }
            ],
        }
    )
    adapter = ResponsesModelAdapter(client=client)

    result = adapter.next_turn(
        items=[RuntimeItem(role="user", blocks=(RuntimeBlock(type="text", text="inspect the repo"),))],
        tools=[],
    )

    block = result.items[0].blocks[0]
    assert block.type == "reasoning"
    assert block.text == "I should inspect pyproject.toml first."
    assert block.metadata["provider_item_type"] == "reasoning"
    assert block.metadata["status"] == "completed"
    assert result.metadata["response_status"] == "completed"
    assert result.metadata["usage"] == {"total_tokens": 42}


def test_responses_adapter_maps_mcp_call_output_to_reasoning_block() -> None:
    client = FakeResponsesClient(
        {
            "id": "resp_123",
            "output": [
                {
                    "id": "mcp_1",
                    "type": "mcp_call",
                    "name": "read_file",
                    "arguments": '{"path":"pyproject.toml"}',
                    "output": "Tool read_file does not exists.",
                    "status": "completed",
                }
            ],
        }
    )
    adapter = ResponsesModelAdapter(client=client)

    result = adapter.next_turn(
        items=[RuntimeItem(role="user", blocks=(RuntimeBlock(type="text", text="inspect"),))],
        tools=[],
    )

    assert result.done is True
    block = result.items[0].blocks[0]
    assert block.type == "reasoning"
    assert block.text == "Provider MCP call read_file completed: Tool read_file does not exists."
    assert block.provider_id == "mcp_1"
    assert block.metadata == {
        "provider_item_type": "mcp_call",
        "status": "completed",
        "name": "read_file",
        "arguments": {"path": "pyproject.toml"},
    }


def test_responses_adapter_ignores_unknown_items_with_warning(caplog) -> None:
    client = FakeResponsesClient(
        {
            "id": "resp_123",
            "output": [
                {
                    "id": "unknown_1",
                    "type": "output_image",
                },
                {
                    "id": "msg_001",
                    "type": "message",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "Known output should still pass through.",
                        }
                    ],
                },
            ],
        }
    )
    adapter = ResponsesModelAdapter(client=client)

    with caplog.at_level(logging.WARNING):
        result = adapter.next_turn(
            items=[RuntimeItem(role="user", blocks=(RuntimeBlock(type="text", text="inspect the repo"),))],
            tools=[],
        )

    assert result.items[0].blocks[0].type == "text"
    assert result.items[0].blocks[0].text == "Known output should still pass through."
    assert "Ignored unsupported Responses item" in caplog.text


def test_responses_adapter_logs_ignored_item_to_workspace_log(tmp_path: Path) -> None:
    client = FakeResponsesClient(
        {
            "id": "resp_123",
            "output": [
                {
                    "id": "unknown_1",
                    "type": "output_image",
                }
            ],
        }
    )
    log_service = WorkspaceLogService(
        workspace_root=tmp_path,
        now_provider=lambda: datetime(2026, 4, 11, 12, 30, 45, tzinfo=timezone.utc),
    )
    adapter = ResponsesModelAdapter(client=client, log_service=log_service)
    adapter.set_log_context_provider(
        lambda: ModelLogContext(session_id="demo", turn_id="turn_ignored_1")
    )

    result = adapter.next_turn(
        items=[RuntimeItem(role="user", blocks=(RuntimeBlock(type="text", text="inspect the repo"),))],
        tools=[],
    )

    assert result.items == ()
    app_log = (tmp_path / "log" / "agent.log").read_text(encoding="utf-8")
    assert "responses_item_ignored" in app_log
    assert "output_image" in app_log
