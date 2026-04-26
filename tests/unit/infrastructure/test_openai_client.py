from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
from openai import APIConnectionError, BadRequestError

from mycli.domain.logging import ModelLogContext
from mycli.domain.model_events import ModelEventType
from mycli.infrastructure.openai_client import (
    DEFAULT_OPENAI_SDK_TIMEOUT_SECONDS,
    ModelResponseError,
    OpenAIChatClient,
    _build_openai_sdk_client,
)
from mycli.infrastructure.providers.deepseek import DeepSeekChatProviderAdapter
from mycli.services.workspace_log_service import WorkspaceLogService


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


class _FakeSdkPayload:
    def __init__(self, payload: dict[str, object]) -> None:
        self._payload = payload

    def to_dict(self) -> dict[str, object]:
        return dict(self._payload)


def _status_error(*, status_code: int, body: dict[str, object]) -> BadRequestError:
    request = httpx.Request("POST", "https://example.invalid/v1/chat/completions")
    response = httpx.Response(status_code, request=request, json=body)
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
        "mycli.infrastructure.openai_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )

    decision = client.decide("Inspect the repo")

    assert sdk_client.chat_completions.calls == [{
        "model": "gpt-test",
        "messages": [{"role": "user", "content": "Inspect the repo"}],
        "max_tokens": 2048,
        "temperature": 0,
    }]
    assert decision.progress_message == "Inspecting the repository"
    assert decision.tool_call is not None
    assert decision.tool_call.name == "list_directory"
    assert decision.tool_call.arguments == {"path": "."}


def test_openai_chat_client_uses_openai_sdk_transport(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={
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
        "mycli.infrastructure.openai_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )

    payload = client.complete([{"role": "user", "content": "Inspect the repo"}])

    assert sdk_client.chat_completions.calls == [
        {
            "model": "gpt-test",
            "messages": [{"role": "user", "content": "Inspect the repo"}],
            "max_tokens": 2048,
            "temperature": 0,
        }
    ]
    assert payload["assistant_message"] == "done"


def test_openai_chat_client_accepts_thinking_config_without_request_failure(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={"choices": [{"message": {"content": "done"}}]}
    )
    monkeypatch.setattr(
        "mycli.infrastructure.openai_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )
    client.set_thinking_config(enabled=True, effort="high")

    payload = client.complete([{"role": "user", "content": "inspect the repo"}])

    assert payload["assistant_message"] == "done"


def test_openai_chat_client_uses_provider_adapter_for_request_body(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={"choices": [{"message": {"content": "done"}}]}
    )
    monkeypatch.setattr(
        "mycli.infrastructure.openai_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://api.deepseek.com",
        model="deepseek-v4-flash",
        max_output_tokens=2048,
        provider_adapter=DeepSeekChatProviderAdapter(),
    )
    client.set_thinking_config(enabled=False, effort=None)

    client.complete([{"role": "user", "content": "inspect the repo"}])

    assert sdk_client.chat_completions.calls[-1]["extra_body"] == {
        "thinking": {"type": "disabled"}
    }


def test_openai_chat_client_uses_provider_adapter_for_message_roles(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        chat_payload={"choices": [{"message": {"content": "done"}}]}
    )
    monkeypatch.setattr(
        "mycli.infrastructure.openai_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://api.deepseek.com",
        model="deepseek-v4-flash",
        max_output_tokens=2048,
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
        "mycli.infrastructure.openai_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
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

    monkeypatch.setattr("mycli.infrastructure.openai_client.OpenAI", FakeOpenAI)

    _build_openai_sdk_client(
        api_key="test-key",
        base_url="https://example.invalid/v1",
    )

    assert captured["timeout"] == DEFAULT_OPENAI_SDK_TIMEOUT_SECONDS
    assert captured["max_retries"] == 0


def test_openai_chat_client_logs_request_and_response_payloads(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        "mycli.infrastructure.openai_client._build_openai_sdk_client",
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
        max_output_tokens=2048,
        log_service=_build_log_service(tmp_path),
        log_context_provider=lambda: ModelLogContext(session_id="demo", turn_id="turn_chat_1"),
    )

    client.complete([{"role": "user", "content": "你好"}])

    raw_dir = tmp_path / "log" / "model-raw"
    request_files = sorted(raw_dir.glob("*-request.json"))
    response_files = sorted(raw_dir.glob("*-response.json"))
    assert len(request_files) == 1
    assert len(response_files) == 1
    request_payload = json.loads(request_files[0].read_text(encoding="utf-8"))
    assert request_payload["body"]["model"] == "gpt-test"
    assert "Authorization" not in json.dumps(request_payload, ensure_ascii=False)


def test_openai_chat_client_falls_back_to_plain_assistant_message_for_non_json_content(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "mycli.infrastructure.openai_client._build_openai_sdk_client",
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
        max_output_tokens=2048,
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
        "mycli.infrastructure.openai_client._build_openai_sdk_client",
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
        max_output_tokens=2048,
    )

    with pytest.raises(ModelResponseError, match="unsupported model"):
        client.complete([{"role": "user", "content": "inspect the repo"}])


def test_openai_chat_client_logs_http_errors(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        "mycli.infrastructure.openai_client._build_openai_sdk_client",
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
        max_output_tokens=2048,
        log_service=_build_log_service(tmp_path),
        log_context_provider=lambda: ModelLogContext(session_id="demo", turn_id="turn_chat_2"),
    )

    with pytest.raises(ModelResponseError, match="unsupported model"):
        client.complete([{"role": "user", "content": "inspect the repo"}])

    error_files = sorted((tmp_path / "log" / "model-raw").glob("*-error.json"))
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
        "mycli.infrastructure.openai_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
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
        "max_tokens": 2048,
        "temperature": 0,
    }]
    assert payload["tool_call"] == {
        "id": "call_list_directory_1",
        "name": "list_directory",
        "arguments": {"path": "."},
        "reason": "model requested tool",
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
        "mycli.infrastructure.openai_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIChatClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
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
        "max_tokens": 2048,
        "temperature": 0,
    }]


def test_openai_chat_client_maps_sdk_connection_errors(monkeypatch) -> None:
    monkeypatch.setattr(
        "mycli.infrastructure.openai_client._build_openai_sdk_client",
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
        max_output_tokens=2048,
    )

    with pytest.raises(ModelResponseError, match="Failed to reach model provider"):
        client.complete([{"role": "user", "content": "inspect the repo"}])
