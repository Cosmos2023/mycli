from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
from openai import APIConnectionError, BadRequestError

from mycli.domain.logging import ModelLogContext
from mycli.domain.model_events import ModelEventType
from mycli.domain.runtime import RuntimeBlock, RuntimeInterruptToken, StopReason
from mycli.llms.clients.openai_chat import (
    DEFAULT_OPENAI_SDK_TIMEOUT_SECONDS,
    ModelResponseError,
    OpenAIChatClient,
    _build_openai_sdk_client,
    classify_chat_provider_failure,
)
from mycli.llms.clients.openai_sdk import build_openai_sdk_client
from mycli.infrastructure.providers.deepseek import (
    DEEPSEEK_SYNTHETIC_REASONING_CONTENT,
    DeepSeekChatProviderAdapter,
)
from mycli.utils.workspace_logger import WorkspaceLogService


class _FakeChatCompletionsApi:
    def __init__(
        self,
        *,
        payload: dict[str, object] | None = None,
        error: Exception | None = None,
    ) -> None:
        self._payload = payload or {"choices": []}
        self._error = error
        self.calls: list[dict[str, object]] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self._error is not None:
            raise self._error
        return _FakeSdkPayload(self._payload)


class _FakeStreamingChatCompletionsApi:
    def __init__(self, *, chunks: list[dict[str, object]]) -> None:
        self._chunks = chunks
        self.calls: list[dict[str, object]] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return [_FakeSdkPayload(chunk) for chunk in self._chunks]


class _CloseAwareStream:
    def __init__(self, chunks: list[dict[str, object]], token: RuntimeInterruptToken) -> None:
        self._chunks = chunks
        self._token = token
        self.closed = False

    def __iter__(self):
        for index, chunk in enumerate(self._chunks):
            if index == 1:
                self._token.request("test_interrupt")
            yield _FakeSdkPayload(chunk)

    def close(self) -> None:
        self.closed = True


class _CloseAwareStreamingChatCompletionsApi:
    def __init__(
        self,
        *,
        chunks: list[dict[str, object]],
        token: RuntimeInterruptToken,
    ) -> None:
        self._chunks = chunks
        self._token = token
        self.calls: list[dict[str, object]] = []
        self.stream: _CloseAwareStream | None = None

    def create(self, **kwargs):
        self.calls.append(kwargs)
        self.stream = _CloseAwareStream(self._chunks, self._token)
        return self.stream


class _FakeOpenAISdkClient:
    def __init__(
        self,
        *,
        chat_payload: dict[str, object] | None = None,
        chat_error: Exception | None = None,
    ) -> None:
        self.chat_completions = _FakeChatCompletionsApi(
            payload=chat_payload,
            error=chat_error,
        )
        self.chat = type(
            "_FakeChatApi",
            (),
            {"completions": self.chat_completions},
        )()
        self.closed = False

    def close(self) -> None:
        self.closed = True


class _FakeStreamingOpenAISdkClient:
    def __init__(self, *, chunks: list[dict[str, object]]) -> None:
        self.chat_completions = _FakeStreamingChatCompletionsApi(chunks=chunks)
        self.chat = type(
            "_FakeChatApi",
            (),
            {"completions": self.chat_completions},
        )()


class _CloseAwareStreamingOpenAISdkClient:
    def __init__(
        self,
        *,
        chunks: list[dict[str, object]],
        token: RuntimeInterruptToken,
    ) -> None:
        self.chat_completions = _CloseAwareStreamingChatCompletionsApi(
            chunks=chunks,
            token=token,
        )
        self.chat = type(
            "_FakeChatApi",
            (),
            {"completions": self.chat_completions},
        )()
        self.closed = False

    def close(self) -> None:
        self.closed = True


class _BlockingStreamingChatCompletionsApi:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()
        self.calls: list[dict[str, object]] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        self.started.set()
        self.release.wait(timeout=30)
        return []


class _BlockingOpenAISdkClient:
    def __init__(self) -> None:
        self.chat_completions = _BlockingStreamingChatCompletionsApi()
        self.chat = type(
            "_FakeChatApi",
            (),
            {"completions": self.chat_completions},
        )()
        self.closed = False

    def close(self) -> None:
        self.closed = True


class _FakeSdkPayload:
    def __init__(self, payload: dict[str, object]) -> None:
        self._payload = payload

    def to_dict(self) -> dict[str, object]:
        return dict(self._payload)


def _status_error(
    *,
    status_code: int,
    body: dict[str, object],
    headers: dict[str, str] | None = None,
) -> BadRequestError:
    request = httpx.Request("POST", "https://example.invalid/v1/chat/completions")
    response = httpx.Response(status_code, request=request, json=body, headers=headers)
    return BadRequestError(str(body), response=response, body=body)


def _build_log_service(tmp_path: Path) -> WorkspaceLogService:
    return WorkspaceLogService(
        workspace_root=tmp_path,
        now_provider=lambda: datetime(2026, 4, 11, 12, 30, 45, tzinfo=timezone.utc),
    )


def test_openai_chat_client_decodes_json_decision(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "assistant_message": None,
                                "progress_message": "Inspecting the repository",
                                "tool_name": "list_directory",
                                "arguments": {"path": "."},
                                "reason": "inspect root",
                                "done": False,
                            }
                        )
                    }
                }
            ]
        }
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    decision = client.decide("Inspect the repo")

    assert sdk_client.chat_completions.calls == [{
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "Inspect the repo"}],
        "temperature": 0,
    }]
    assert decision.progress_message == "Inspecting the repository"
    assert decision.tool_call is not None
    assert decision.tool_call.name == "list_directory"
    assert decision.tool_call.arguments == {"path": "."}


def test_openai_chat_client_uses_openai_sdk_transport(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "id": "chatcmpl_multi_tool",
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "assistant_message": "done",
                                "progress_message": None,
                                "tool_name": None,
                                "arguments": {},
                                "reason": "complete",
                                "done": True,
                            }
                        )
                    }
                }
            ]
        }
    )

    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    payload = client.complete([{"role": "user", "content": "Inspect the repo"}])

    assert sdk_client.chat_completions.calls == [
        {
            "model": "gpt-test",
            "messages": [{"role": "user", "content": "Inspect the repo"}],
            "temperature": 0,
        }
    ]
    assert payload["assistant_message"] == "done"


def test_openai_chat_client_uses_prompt_cache_key_request_option(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={"choices": [{"message": {"content": "done"}}]}
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    client.complete(
        [
            {
                "role": "user",
                "content": "Inspect the repo",
                "metadata": {
                    "provider_request_policy": {
                        "prompt_cache_key": "mycli:compatible:chat:stable"
                    }
                },
            }
        ]
    )

    assert sdk_client.chat_completions.calls[-1]["prompt_cache_key"] == (
        "mycli:compatible:chat:stable"
    )
    assert sdk_client.chat_completions.calls[-1]["messages"] == [
        {"role": "user", "content": "Inspect the repo"}
    ]


def test_openai_chat_client_serializes_image_blocks(monkeypatch, tmp_path: Path) -> None:
    image_path = tmp_path / "tiny.png"
    image_path.write_bytes(
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
        b"\x1f\x15\xc4\x89"
    )
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={"choices": [{"message": {"content": "done"}}]}
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )
    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    client.complete(
        [
            {
                "role": "user",
                "content": "Describe [image #1]",
                "blocks": (
                    RuntimeBlock(type="text", text="Describe [image #1]"),
                    RuntimeBlock(type="image", metadata={"path": str(image_path)}),
                ),
            }
        ]
    )

    message = sdk_client.chat_completions.calls[-1]["messages"][0]
    assert message["content"][0] == {"type": "text", "text": "Describe [image #1]"}
    assert message["content"][1]["type"] == "image_url"
    assert message["content"][1]["image_url"]["url"].startswith("data:image/png;base64,")
    assert "blocks" not in message


def test_openai_chat_client_strips_runtime_blocks_for_deepseek(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={"choices": [{"message": {"content": "done"}}]}
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )
    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="deepseek-test",
        provider_adapter=DeepSeekChatProviderAdapter(),
    )

    client.complete(
        [
            {
                "role": "user",
                "content": "Say ok.",
                "blocks": (RuntimeBlock(type="text", text="Say ok."),),
            }
        ]
    )

    messages = sdk_client.chat_completions.calls[-1]["messages"]
    assert messages == [{"role": "user", "content": "Say ok."}]
    json.dumps({"messages": messages})


def test_openai_chat_client_sends_tool_choice_none_with_stable_tools(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={"choices": [{"message": {"content": "done"}}]}
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )
    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )
    client.set_tool_choice("none")

    payload = client.complete(
        [{"role": "user", "content": "answer now"}],
        tools=[
            {
                "name": "read_file",
                "description": "Read a file",
                "parameters": [{"name": "path", "type": "string", "required": True}],
            }
        ],
    )

    assert payload["assistant_message"] == "done"
    assert sdk_client.chat_completions.calls[-1]["tool_choice"] == "none"
    assert len(sdk_client.chat_completions.calls[-1]["tools"]) == 1


def test_openai_chat_client_accepts_thinking_config_without_request_failure(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={"choices": [{"message": {"content": "done"}}]}
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )
    client.set_thinking_config(enabled=True, effort="high")

    payload = client.complete([{"role": "user", "content": "inspect the repo"}])

    assert payload["assistant_message"] == "done"


def test_openai_chat_client_omits_model_output_limit(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {"content": "done"},
                }
            ]
        }
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )
    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    client.complete(messages=[{"role": "user", "content": "inspect"}])

    assert "max_tokens" not in sdk_client.chat_completions.calls[-1]


def test_openai_chat_client_rejects_non_streaming_length_finish_reason(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "choices": [
                {
                    "finish_reason": "length",
                    "message": {"content": "partial"},
                }
            ]
        }
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )
    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    with pytest.raises(ModelResponseError) as exc_info:
        client.complete(messages=[{"role": "user", "content": "inspect"}])

    assert exc_info.value.failure_kind == "output_token_limit"


def test_openai_chat_client_rejects_streaming_length_finish_reason(
    monkeypatch,
) -> None:
    sdk_client = _FakeStreamingOpenAISdkClient(
        chunks=[
            {
                "id": "chatcmpl_stream",
                "choices": [{"delta": {"content": "partial"}}],
            },
            {
                "id": "chatcmpl_stream",
                "choices": [{"delta": {}, "finish_reason": "length"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 2048},
            },
        ]
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )
    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    with pytest.raises(ModelResponseError) as exc_info:
        list(client.stream_events(input_items=[{"role": "user", "content": "inspect"}]))

    assert exc_info.value.failure_kind == "output_token_limit"


def test_openai_chat_client_create_events_preserves_usage_metadata(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "choices": [{"message": {"content": "done"}}],
            "usage": {
                "prompt_tokens": 100,
                "prompt_tokens_details": {"cached_tokens": 64},
            },
        }
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )
    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    events = client.create_events(input_items=[{"role": "user", "content": "inspect"}])

    completed = [event for event in events if event.type is ModelEventType.TURN_COMPLETED]
    assert completed[0].usage == {
        "prompt_tokens": 100,
        "prompt_tokens_details": {"cached_tokens": 64},
    }


def test_openai_chat_client_stream_events_normalizes_chat_chunks(monkeypatch) -> None:
    sdk_client = _FakeStreamingOpenAISdkClient(
        chunks=[
            {"id": "chatcmpl_stream", "choices": [{"delta": {"reasoning_content": "thinking"}}]},
            {"id": "chatcmpl_stream", "choices": [{"delta": {"content": "hello "}}]},
            {"id": "chatcmpl_stream", "choices": [{"delta": {"content": "world"}}]},
            {
                "id": "chatcmpl_stream",
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "call_1",
                                    "type": "function",
                                    "function": {
                                        "name": "Read",
                                        "arguments": '{"file_path":"README.md"}',
                                    },
                                }
                            ]
                        }
                    }
                ],
            },
            {
                "id": "chatcmpl_stream",
                "choices": [{"finish_reason": "tool_calls"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 3},
            },
        ]
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )
    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    events = list(
        client.stream_events(
            input_items=[{"role": "user", "content": "inspect"}],
            tools=[],
        )
    )

    assert [event.type for event in events] == [
        ModelEventType.REASONING_DELTA,
        ModelEventType.MESSAGE_DELTA,
        ModelEventType.MESSAGE_DELTA,
        ModelEventType.TOOL_CALL_REQUESTED,
        ModelEventType.TURN_COMPLETED,
    ]
    assert events[0].text == "thinking"
    assert events[1].text == "hello "
    assert events[2].text == "world"
    assert events[3].tool_name == "Read"
    assert events[3].tool_arguments == {"file_path": "README.md"}
    assert events[3].call_id == "call_1"
    assert events[4].response_id == "chatcmpl_stream"
    assert events[4].usage == {"prompt_tokens": 10, "completion_tokens": 3}
    assert sdk_client.chat_completions.calls[-1]["stream"] is True
    assert sdk_client.chat_completions.calls[-1]["stream_options"] == {
        "include_usage": True
    }


def test_openai_chat_client_stream_events_decodes_dsml_tool_calls(monkeypatch) -> None:
    dsml_content = (
        "<｜｜DSML｜｜tool_calls>\n"
        '<｜｜DSML｜｜invoke name="Bash">\n'
        '<｜｜DSML｜｜parameter name="command" string="true">pwd</｜｜DSML｜｜parameter>\n'
        '<｜｜DSML｜｜parameter name="timeout" string="false">5000</｜｜DSML｜｜parameter>\n'
        "</｜｜DSML｜｜invoke>\n"
        "</｜｜DSML｜｜tool_calls>"
    )
    sdk_client = _FakeStreamingOpenAISdkClient(
        chunks=[
            {"id": "chatcmpl_stream", "choices": [{"delta": {"content": dsml_content[:20]}}]},
            {"id": "chatcmpl_stream", "choices": [{"delta": {"content": dsml_content[20:]}}]},
            {
                "id": "chatcmpl_stream",
                "choices": [{"finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 3},
            },
        ]
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )
    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://api.deepseek.com",
        model="deepseek-v4-flash",
        provider_adapter=DeepSeekChatProviderAdapter(),
    )

    events = list(
        client.stream_events(
            input_items=[{"role": "user", "content": "inspect"}],
            tools=[{"name": "Bash", "description": "Run shell", "parameters": []}],
        )
    )

    assert [event.type for event in events] == [
        ModelEventType.TOOL_CALL_REQUESTED,
        ModelEventType.TURN_COMPLETED,
    ]
    assert events[0].tool_name == "Bash"
    assert events[0].tool_arguments == {"command": "pwd", "timeout": 5000}
    assert events[0].call_id == "chatcmpl_stream_dsml_tool_call_0"
    assert events[1].usage == {"prompt_tokens": 10, "completion_tokens": 3}


def test_openai_chat_client_complete_decodes_dsml_tool_calls(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "id": "chatcmpl_complete",
            "choices": [
                {
                    "message": {
                        "content": (
                            "<｜｜DSML｜｜tool_calls>\n"
                            '<｜｜DSML｜｜invoke name="Read">\n'
                            '<｜｜DSML｜｜parameter name="file_path" string="true">README.md</｜｜DSML｜｜parameter>\n'
                            "</｜｜DSML｜｜invoke>\n"
                            "</｜｜DSML｜｜tool_calls>"
                        )
                    }
                }
            ]
        }
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )
    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://api.deepseek.com",
        model="deepseek-v4-flash",
        provider_adapter=DeepSeekChatProviderAdapter(),
    )

    payload = client.complete(
        messages=[{"role": "user", "content": "inspect"}],
        tools=[{"name": "Read", "description": "Read file", "parameters": []}],
    )

    assert payload["assistant_message"] is None
    assert payload["tool_call"] == {
        "id": "chatcmpl_complete_dsml_tool_call_0",
        "name": "Read",
        "arguments": {"file_path": "README.md"},
        "reason": "model requested tool",
    }
    assert payload["done"] is False


def test_openai_chat_client_closes_stream_when_interrupt_token_is_requested(
    monkeypatch,
) -> None:
    token = RuntimeInterruptToken()
    sdk_client = _CloseAwareStreamingOpenAISdkClient(
        chunks=[
            {"id": "chatcmpl_stream", "choices": [{"delta": {"content": "before"}}]},
            {"id": "chatcmpl_stream", "choices": [{"delta": {"content": "after"}}]},
        ],
        token=token,
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )
    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    events = list(
        client.stream_events(
            input_items=[{"role": "user", "content": "inspect"}],
            tools=[],
            interrupt_token=token,
        )
    )

    assert [event.text for event in events] == ["before"]
    assert sdk_client.chat_completions.stream is not None
    assert sdk_client.chat_completions.stream.closed is True


def test_openai_chat_client_closes_sdk_client_when_interrupted_before_stream_exists(
    monkeypatch,
) -> None:
    token = RuntimeInterruptToken()
    sdk_clients: list[_BlockingOpenAISdkClient] = []

    def fake_build(**_: object) -> _BlockingOpenAISdkClient:
        sdk_client = _BlockingOpenAISdkClient()
        sdk_clients.append(sdk_client)
        return sdk_client

    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        fake_build,
    )
    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )
    first_client = sdk_clients[0]
    result_holder: dict[str, object] = {}

    def consume() -> None:
        try:
            result_holder["events"] = list(
                client.stream_events_with_interrupt(
                    input_items=[{"role": "user", "content": "inspect"}],
                    tools=[],
                    interrupt_token=token,
                )
            )
        except BaseException as exc:  # noqa: BLE001 - asserted below.
            result_holder["exception"] = exc

    thread = threading.Thread(target=consume)
    thread.start()
    assert first_client.chat_completions.started.wait(timeout=1.0)
    token.request("test_interrupt")
    try:
        assert first_client.closed is True
        assert len(sdk_clients) == 2
        assert sdk_clients[-1] is not first_client
    finally:
        first_client.chat_completions.release.set()
        thread.join(timeout=3.0)


def test_openai_chat_client_uses_provider_adapter_for_request_body(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={"choices": [{"message": {"content": "done"}}]}
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://api.deepseek.com",
        model="deepseek-v4-flash",
        provider_adapter=DeepSeekChatProviderAdapter(),
    )
    client.set_thinking_config(enabled=False, effort=None)

    client.complete([{"role": "user", "content": "inspect the repo"}])

    assert sdk_client.chat_completions.calls[-1]["extra_body"] == {
        "thinking": {"type": "disabled"}
    }


def test_openai_chat_client_enables_deepseek_thinking_with_supported_effort(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={"choices": [{"message": {"content": "done"}}]}
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )
    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://api.deepseek.com",
        model="deepseek-v4-flash",
        provider_adapter=DeepSeekChatProviderAdapter(),
    )

    client.set_thinking_config(enabled=True, effort="medium")
    client.complete([{"role": "user", "content": "inspect the repo"}])

    body = sdk_client.chat_completions.calls[-1]
    assert body["extra_body"] == {"thinking": {"type": "enabled"}}
    assert body["reasoning_effort"] == "high"


def test_openai_chat_client_uses_provider_adapter_for_message_roles(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={"choices": [{"message": {"content": "done"}}]}
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://api.deepseek.com",
        model="deepseek-v4-flash",
        provider_adapter=DeepSeekChatProviderAdapter(),
    )

    client.complete(
        [
            {"role": "developer", "content": "You are a careful assistant."},
            {"role": "user", "content": "inspect the repo"},
        ]
    )

    assert sdk_client.chat_completions.calls[-1]["messages"] == [
        {"role": "system", "content": "You are a careful assistant."},
        {"role": "user", "content": "inspect the repo"},
    ]


def test_openai_chat_client_preserves_deepseek_reasoning_content_on_tool_call(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "choices": [
                {
                    "message": {
                        "content": "I will read the requested file.",
                        "reasoning_content": "I need to inspect the requested file.",
                        "tool_calls": [
                            {
                                "id": "call_read_file_1",
                                "type": "function",
                                "function": {
                                    "name": "read_file",
                                    "arguments": '{"path":"mission.txt"}',
                                },
                            }
                        ],
                    }
                }
            ]
        }
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://api.deepseek.com",
        model="deepseek-v4-flash",
        provider_adapter=DeepSeekChatProviderAdapter(),
    )

    events = client.create_events(
        input_items=[{"role": "user", "content": "read mission.txt"}],
        tools=[
            {
                "name": "read_file",
                "description": "Read a file",
                "parameters": [{"name": "path", "type": "string"}],
            }
        ],
    )

    tool_event = next(event for event in events if event.tool_name == "read_file")
    message_event = next(
        event
        for event in events
        if event.type is ModelEventType.MESSAGE_DELTA
    )
    assert message_event.metadata["deepseek"] == {
        "reasoning_content": "I need to inspect the requested file."
    }
    assert tool_event.metadata["deepseek"] == {
        "reasoning_content": "I need to inspect the requested file."
    }


def test_openai_chat_client_emits_all_tool_calls_with_deepseek_reasoning_content(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "id": "chatcmpl_multi_tool",
            "choices": [
                {
                    "message": {
                        "content": None,
                        "reasoning_content": "I need to inspect source and tests.",
                        "tool_calls": [
                            {
                                "id": "call_list_src",
                                "type": "function",
                                "function": {
                                    "name": "list_directory",
                                    "arguments": '{"path":"src"}',
                                },
                            },
                            {
                                "id": "call_list_tests",
                                "type": "function",
                                "function": {
                                    "name": "list_directory",
                                    "arguments": '{"path":"tests"}',
                                },
                            },
                            {
                                "id": "call_read_readme",
                                "type": "function",
                                "function": {
                                    "name": "read_file",
                                    "arguments": '{"path":"README.md"}',
                                },
                            },
                        ],
                    }
                }
            ]
        }
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://api.deepseek.com",
        model="deepseek-v4-flash",
        provider_adapter=DeepSeekChatProviderAdapter(),
    )

    events = client.create_events(
        input_items=[{"role": "user", "content": "inspect the repo"}],
        tools=[
            {
                "name": "list_directory",
                "description": "List entries in a directory",
                "parameters": [{"name": "path", "type": "string"}],
            },
            {
                "name": "read_file",
                "description": "Read a file",
                "parameters": [{"name": "path", "type": "string"}],
            },
        ],
    )

    tool_events = [
        event
        for event in events
        if event.type is ModelEventType.TOOL_CALL_REQUESTED
    ]

    assert [(event.call_id, event.tool_name, event.tool_arguments) for event in tool_events] == [
        ("call_list_src", "list_directory", {"path": "src"}),
        ("call_list_tests", "list_directory", {"path": "tests"}),
        ("call_read_readme", "read_file", {"path": "README.md"}),
    ]
    assert [
        event.metadata.get("deepseek")
        for event in tool_events
    ] == [
        {"reasoning_content": "I need to inspect source and tests."},
        {"reasoning_content": "I need to inspect source and tests."},
        {"reasoning_content": "I need to inspect source and tests."},
    ]
    assert [event.provider_id for event in tool_events] == [
        "chatcmpl_multi_tool",
        "chatcmpl_multi_tool",
        "chatcmpl_multi_tool",
    ]


def test_openai_chat_client_marks_missing_deepseek_reasoning_on_tool_call(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "id": "chatcmpl_missing_reasoning",
            "choices": [
                {
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_pwd",
                                "type": "function",
                                "function": {
                                    "name": "run_shell",
                                    "arguments": '{"args":["pwd"]}',
                                },
                            }
                        ],
                    }
                }
            ]
        }
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )
    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://api.deepseek.com",
        model="deepseek-v4-flash",
        provider_adapter=DeepSeekChatProviderAdapter(),
    )

    events = client.create_events(
        input_items=[{"role": "user", "content": "pwd"}],
        tools=[
            {
                "name": "run_shell",
                "description": "Run a command",
                "parameters": [{"name": "args", "type": "array"}],
            }
        ],
    )

    tool_event = next(
        event for event in events if event.type is ModelEventType.TOOL_CALL_REQUESTED
    )
    assert tool_event.provider_id == "chatcmpl_missing_reasoning"
    assert tool_event.metadata["deepseek"] == {
        "reasoning_content": DEEPSEEK_SYNTHETIC_REASONING_CONTENT,
        "reasoning_content_missing": True,
    }


def test_openai_chat_client_preserves_deepseek_reasoning_content_on_text(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "choices": [
                {
                    "message": {
                        "content": "Mission complete.",
                        "role": "assistant",
                        "reasoning_content": "I have enough evidence to answer.",
                    }
                }
            ]
        }
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://api.deepseek.com",
        model="deepseek-v4-flash",
        provider_adapter=DeepSeekChatProviderAdapter(),
    )

    events = client.create_events(
        input_items=[{"role": "user", "content": "finish"}],
        tools=[],
    )

    message_event = next(
        event
        for event in events
        if event.type is ModelEventType.MESSAGE_DELTA
    )
    assert message_event.metadata["deepseek"] == {
        "reasoning_content": "I have enough evidence to answer."
    }


def test_openai_chat_client_maps_tool_call_payload_to_model_events(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "choices": [
                {
                    "message": {
                        "tool_calls": [
                            {
                                "id": "call_001",
                                "type": "function",
                                "function": {
                                    "name": "list_directory",
                                    "arguments": "{\"path\":\".\"}",
                                },
                            }
                        ],
                        "content": "I will inspect the repository.",
                    }
                }
            ]
        }
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    events = client.create_events(
        input_items=[{"role": "user", "content": "inspect the repo"}],
        tools=[],
    )

    assert [event.type for event in events] == [
        ModelEventType.MESSAGE_DELTA,
        ModelEventType.TOOL_CALL_REQUESTED,
        ModelEventType.TURN_COMPLETED,
    ]


def test_build_openai_sdk_client_uses_extended_timeout(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class FakeOpenAI:
        def __init__(self, **kwargs) -> None:
            captured.update(kwargs)

    monkeypatch.setattr("mycli.llms.clients.openai_chat.OpenAI", FakeOpenAI)

    _build_openai_sdk_client(
        api_key="test-key",
        base_url="https://example.invalid/v1",
    )

    assert captured["timeout"] == DEFAULT_OPENAI_SDK_TIMEOUT_SECONDS
    assert captured["max_retries"] == 4
    assert captured["default_headers"] == {"User-Agent": "mycli/0.1.0"}


def test_standalone_openai_sdk_client_uses_mycli_user_agent(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class FakeOpenAI:
        def __init__(self, **kwargs) -> None:
            captured.update(kwargs)

    monkeypatch.setattr("mycli.llms.clients.openai_sdk.OpenAI", FakeOpenAI)

    build_openai_sdk_client(
        api_key="test-key",
        base_url="https://example.invalid/v1",
    )

    assert captured["default_headers"] == {"User-Agent": "mycli/0.1.0"}


def test_openai_chat_client_logs_request_and_response_payloads(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: _FakeOpenAISdkClient(
            chat_payload={
                "choices": [
                    {
                        "message": {
                            "content": "你好，我可以帮你分析仓库。"
                        }
                    }
                ]
            }
        ),
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        log_service=_build_log_service(tmp_path),
        log_context_provider=lambda: ModelLogContext(session_id="demo", turn_id="turn_chat_1"),
    )

    client.complete([{"role": "user", "content": "你好"}])

    raw_dir = tmp_path / "log" / "model-raw"
    request_files = sorted(raw_dir.glob("*/*-request.json"))
    response_files = sorted(raw_dir.glob("*/*-response.json"))
    assert len(request_files) == 1
    assert len(response_files) == 1
    request_payload = json.loads(request_files[0].read_text(encoding="utf-8"))
    assert request_payload["body"]["model"] == "gpt-test"
    assert "Authorization" not in json.dumps(request_payload, ensure_ascii=False)


def test_openai_chat_client_falls_back_to_plain_assistant_message_for_non_json_content(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: _FakeOpenAISdkClient(
            chat_payload={
                "choices": [
                    {
                        "message": {
                            "content": "你好，我可以帮你分析仓库。"
                        }
                    }
                ]
            }
        ),
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    payload = client.complete([{"role": "user", "content": "你好"}])

    assert payload == {
        "assistant_message": "你好，我可以帮你分析仓库。",
        "progress_message": None,
        "tool_name": None,
        "arguments": {},
        "reason": "plain text fallback",
        "done": True,
    }


def test_openai_chat_client_surfaces_http_error_body(monkeypatch) -> None:
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: _FakeOpenAISdkClient(
            chat_error=_status_error(
                status_code=400,
                body={"error": {"message": "unsupported model"}},
            )
        ),
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    with pytest.raises(ModelResponseError, match="unsupported model"):
        client.complete([{"role": "user", "content": "inspect the repo"}])


def test_openai_chat_client_logs_http_errors(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: _FakeOpenAISdkClient(
            chat_error=_status_error(
                status_code=400,
                body={"error": {"message": "unsupported model"}},
            )
        ),
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        log_service=_build_log_service(tmp_path),
        log_context_provider=lambda: ModelLogContext(session_id="demo", turn_id="turn_chat_2"),
    )

    with pytest.raises(ModelResponseError, match="unsupported model"):
        client.complete([{"role": "user", "content": "inspect the repo"}])

    error_files = sorted((tmp_path / "log" / "model-raw").glob("*/*-error.json"))
    assert len(error_files) == 1
    error_payload = json.loads(error_files[0].read_text(encoding="utf-8"))
    assert error_payload["error_type"] == "BadRequestError"


def test_openai_chat_client_serializes_native_tool_request_and_parses_tool_call(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "choices": [
                {
                    "message": {
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_list_directory_1",
                                "type": "function",
                                "function": {
                                    "name": "list_directory",
                                    "arguments": '{"path":"."}',
                                },
                            }
                        ],
                    }
                }
            ]
        }
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    payload = client.complete(
        [{"role": "user", "content": "当前目录下都有哪些文件"}],
        tools=[
            {
                "name": "list_directory",
                "description": "List entries in a directory",
                "parameters": [
                    {
                        "name": "path",
                        "type": "string",
                        "required": True,
                        "description": "Workspace relative path",
                    }
                ],
            }
        ],
    )

    assert sdk_client.chat_completions.calls == [{
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "当前目录下都有哪些文件"}],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "list_directory",
                    "description": "List entries in a directory",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {
                                "type": "string",
                                "description": "Workspace relative path",
                            }
                        },
                        "required": ["path"],
                        "additionalProperties": False,
                    },
                },
            }
        ],
        "temperature": 0,
    }]
    assert payload["tool_call"] == {
        "id": "call_list_directory_1",
        "name": "list_directory",
        "arguments": {"path": "."},
        "reason": "model requested tool",
    }


def test_openai_chat_client_uses_wire_safe_tool_names_and_restores_canonical_names(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "choices": [
                {
                    "message": {
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_skill_review_1",
                                "type": "function",
                                "function": {
                                    "name": "skill_code-review",
                                    "arguments": '{"skill_name":"code-review"}',
                                },
                            }
                        ],
                    }
                }
            ]
        }
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://api.deepseek.com",
        model="deepseek-v4-flash",
    )

    payload = client.complete(
        [{"role": "user", "content": "review the current diff"}],
        tools=[
            {
                "name": "skill.code-review",
                "description": "Load the code-review skill",
                "parameters": [{"name": "skill_name", "type": "string"}],
            }
        ],
    )

    sent_tool = sdk_client.chat_completions.calls[0]["tools"][0]
    assert sent_tool["function"]["name"] == "skill_code-review"
    assert payload["tool_call"] == {
        "id": "call_skill_review_1",
        "name": "skill.code-review",
        "arguments": {"skill_name": "code-review"},
        "reason": "model requested tool",
    }


def test_openai_chat_client_disambiguates_colliding_wire_safe_tool_names(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "choices": [
                {
                    "message": {
                        "content": "done",
                    }
                }
            ]
        }
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    client.complete(
        [{"role": "user", "content": "inspect"}],
        tools=[
            {
                "name": "skill.review",
                "description": "Load review skill",
                "parameters": [],
            },
            {
                "name": "skill_review",
                "description": "Run review tool",
                "parameters": [],
            },
        ],
    )

    wire_names = [
        tool["function"]["name"]
        for tool in sdk_client.chat_completions.calls[0]["tools"]
    ]
    assert len(wire_names) == len(set(wire_names))
    assert all("." not in name for name in wire_names)
    assert all(name.startswith("skill_review_") for name in wire_names)


def test_openai_chat_client_rewrites_replayed_assistant_tool_call_names(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "choices": [
                {
                    "message": {
                        "content": "done",
                    }
                }
            ]
        }
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://api.deepseek.com",
        model="deepseek-v4-flash",
    )

    client.complete(
        [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_skill_review_1",
                        "type": "function",
                        "function": {
                            "name": "skill.code-review",
                            "arguments": '{"skill_name":"code-review"}',
                        },
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_skill_review_1",
                "content": "Activated skill: code-review",
            },
            {"role": "user", "content": "continue"},
        ],
        tools=[],
    )

    replayed_call = sdk_client.chat_completions.calls[0]["messages"][0]["tool_calls"][0]
    assert replayed_call["function"]["name"] == "skill_code-review"


def test_openai_chat_client_repairs_python_literal_native_tool_arguments(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "choices": [
                {
                    "message": {
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_read_file_1",
                                "type": "function",
                                "function": {
                                    "name": "read_file",
                                    "arguments": "{'path': 'README.md'}",
                                },
                            }
                        ],
                    }
                }
            ]
        }
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    payload = client.complete(
        [{"role": "user", "content": "read README"}],
        tools=[
            {
                "name": "read_file",
                "description": "Read a file",
                "parameters": [{"name": "path", "type": "string"}],
            }
        ],
    )

    assert payload["tool_call"] == {
        "id": "call_read_file_1",
        "name": "read_file",
        "arguments": {"path": "README.md"},
        "reason": "model requested tool",
    }


def test_openai_chat_client_preserves_unrepairable_native_tool_call_as_invalid_args(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "choices": [
                {
                    "message": {
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_read_file_1",
                                "type": "function",
                                "function": {
                                    "name": "read_file",
                                    "arguments": '{"path":',
                                },
                            }
                        ],
                    }
                }
            ]
        }
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    payload = client.complete(
        [{"role": "user", "content": "read README"}],
        tools=[
            {
                "name": "read_file",
                "description": "Read a file",
                "parameters": [{"name": "path", "type": "string"}],
            }
        ],
    )

    assert payload["tool_call"] == {
        "id": "call_read_file_1",
        "name": "read_file",
        "arguments": {},
        "reason": "model requested tool",
        "metadata": {
            "native_tool_arguments_parse_error": "Native tool call arguments were not valid JSON.",
            "native_tool_arguments_raw": '{"path":',
        },
    }


def test_openai_chat_client_omits_null_parameter_descriptions_in_native_tool_schema(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
            "choices": [
                {
                    "message": {
                        "content": "列出了当前目录。",
                    }
                }
            ]
        }
    )
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    client.complete(
        [{"role": "user", "content": "当前目录下都有哪些文件"}],
        tools=[
            {
                "name": "list_directory",
                "description": "List entries in a directory",
                "parameters": [
                    {
                        "name": "path",
                        "type": "string",
                        "required": True,
                    }
                ],
            }
        ],
    )

    assert sdk_client.chat_completions.calls == [{
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "当前目录下都有哪些文件"}],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "list_directory",
                    "description": "List entries in a directory",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {
                                "type": "string",
                            }
                        },
                        "required": ["path"],
                        "additionalProperties": False,
                    },
                },
            }
        ],
        "temperature": 0,
    }]


def test_openai_chat_client_maps_sdk_connection_errors(monkeypatch) -> None:
    monkeypatch.setattr(
        "mycli.llms.clients.openai_chat._build_openai_sdk_client",
        lambda **_: _FakeOpenAISdkClient(
            chat_error=APIConnectionError(
                message="connection reset by peer",
                request=httpx.Request("POST", "https://example.invalid/v1/chat/completions"),
            )
        ),
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
    )

    with pytest.raises(ModelResponseError, match="Failed to reach model provider") as exc_info:
        client.complete([{"role": "user", "content": "inspect the repo"}])

    assert exc_info.value.stop_reason is StopReason.TRANSPORT_FAILED
    assert exc_info.value.failure_kind == "transport_error"
    assert exc_info.value.is_retryable is True


def test_openai_chat_status_errors_use_shared_failure_taxonomy() -> None:
    classification = classify_chat_provider_failure(
        detail="rate limit exceeded",
        status_code=429,
        provider_error_code=None,
    )

    assert classification.stop_reason is StopReason.RATE_LIMITED
    assert classification.failure_kind == "rate_limited"
    assert classification.is_retryable is True


def test_openai_chat_status_error_sets_model_response_recovery_fields(tmp_path: Path) -> None:
    client = OpenAIChatClient(
        api_key="test",
        base_url="https://api.test/v1",
        model="test-model",
        log_service=WorkspaceLogService(workspace_root=tmp_path),
    )
    exc = _status_error(status_code=429, body={"error": {"message": "rate limit exceeded"}})

    error = client._status_error(exc=exc, request_path=None)

    assert error.stop_reason is StopReason.RATE_LIMITED
    assert error.failure_kind == "rate_limited"
    assert error.is_retryable is True


def test_openai_chat_status_error_preserves_retry_after_header(tmp_path: Path) -> None:
    client = OpenAIChatClient(
        api_key="test",
        base_url="https://api.test/v1",
        model="test-model",
        log_service=WorkspaceLogService(workspace_root=tmp_path),
    )
    exc = _status_error(
        status_code=429,
        body={"error": {"message": "rate limit exceeded"}},
        headers={"retry-after": "2.5"},
    )

    error = client._status_error(exc=exc, request_path=None)

    assert error.retry_after_seconds == pytest.approx(2.5)
