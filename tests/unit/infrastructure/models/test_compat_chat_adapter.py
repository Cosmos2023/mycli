from mycli.llms.adapters.base import ModelMessage, ModelToolDefinition, ModelToolParameter
from mycli.llms.adapters.compat_chat_adapter import CompatChatModelAdapter


class FakeChatClient:
    def complete(self, _messages: list[dict[str, object]]) -> dict[str, object]:
        return {
            "assistant_message": None,
            "tool_name": "list_directory",
            "arguments": {"path": "."},
            "reason": "inspect root",
            "done": False,
        }


def test_compat_adapter_translates_json_payload_into_runtime_action() -> None:
    adapter = CompatChatModelAdapter(chat_client=FakeChatClient())

    action = adapter.next_action(
        messages=[ModelMessage(role="user", content="inspect the repo")],
        tools=[
            ModelToolDefinition(
                name="list_directory",
                description="List a directory",
                parameters=(ModelToolParameter(name="path", type="string"),),
            )
        ],
    )

    assert action.tool_call is not None
    assert action.tool_call.name == "list_directory"


class PlainTextFallbackClient:
    def complete(self, _messages: list[dict[str, object]]) -> dict[str, object]:
        return {
            "assistant_message": "你好，我可以直接回复普通文本。",
            "progress_message": None,
            "tool_name": None,
            "arguments": {},
            "reason": "plain text fallback",
            "done": True,
        }


def test_compat_adapter_accepts_plain_text_fallback_payload() -> None:
    adapter = CompatChatModelAdapter(chat_client=PlainTextFallbackClient())

    action = adapter.next_action(
        messages=[ModelMessage(role="user", content="你好")],
        tools=[],
    )

    assert action.assistant_message == "你好，我可以直接回复普通文本。"
    assert action.tool_call is None
    assert action.done is True
