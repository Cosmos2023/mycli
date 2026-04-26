from mycli.domain.tools import ToolCall
from mycli.infrastructure.models.base import ModelMessage, ModelToolDefinition, ModelToolParameter
from mycli.infrastructure.models.native_tool_adapter import NativeToolModelAdapter


class FakeNativeClient:
    def __init__(self) -> None:
        self.captured_messages: list[dict[str, object]] = []
        self.captured_tools: list[dict[str, object]] = []

    def complete(
        self,
        *,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> dict[str, object]:
        self.captured_messages = messages
        self.captured_tools = tools
        return {
            "assistant_message": None,
            "progress_message": "calling native tool",
            "tool_call": {
                "id": "call_read_file_1",
                "name": "read_file",
                "arguments": {"path": "README.md"},
                "reason": "inspect docs",
            },
            "done": False,
        }


def test_native_tool_adapter_translates_shared_messages_and_tools() -> None:
    client = FakeNativeClient()
    adapter = NativeToolModelAdapter(client=client)

    action = adapter.next_action(
        messages=[
            ModelMessage(role="system", content="You are mycli."),
            ModelMessage(role="user", content="inspect the docs"),
        ],
        tools=[
            ModelToolDefinition(
                name="read_file",
                description="Read a file",
                parameters=(ModelToolParameter(name="path", type="string"),),
            )
        ],
    )

    assert client.captured_messages[0]["role"] == "system"
    assert client.captured_tools[0]["name"] == "read_file"
    assert action.progress_message == "calling native tool"
    assert action.tool_call is not None
    assert action.tool_call.call_id == "call_read_file_1"
    assert action.tool_call.name == "read_file"


def test_native_tool_adapter_maps_developer_messages_to_system_role() -> None:
    client = FakeNativeClient()
    adapter = NativeToolModelAdapter(client=client)

    adapter.next_action(
        messages=[
            ModelMessage(role="developer", content="Follow repository instructions."),
            ModelMessage(role="user", content="inspect the docs"),
        ],
        tools=[],
    )

    assert client.captured_messages[0]["role"] == "system"
    assert client.captured_messages[0]["content"] == "Follow repository instructions."


def test_native_tool_adapter_serializes_assistant_tool_calls_and_tool_messages() -> None:
    client = FakeNativeClient()
    adapter = NativeToolModelAdapter(client=client)

    adapter.next_action(
        messages=[
            ModelMessage(
                role="assistant",
                content="",
                tool_calls=(
                    ToolCall(
                        name="list_directory",
                        arguments={"path": "."},
                        reason="inspect root",
                        call_id="call_list_directory_1",
                    ),
                ),
            ),
            ModelMessage(
                role="tool",
                content="Tool list_directory: README.md, src",
                tool_call_id="call_list_directory_1",
            ),
        ],
        tools=[],
    )

    assert client.captured_messages[0]["tool_calls"][0]["id"] == "call_list_directory_1"
    assert client.captured_messages[0]["tool_calls"][0]["function"]["arguments"] == '{"path": "."}'
    assert client.captured_messages[1]["tool_call_id"] == "call_list_directory_1"
