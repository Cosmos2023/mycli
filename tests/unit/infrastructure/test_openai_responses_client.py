from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
from openai import APIConnectionError, BadRequestError, NotFoundError

from mycli.domain.runtime import StopReason
from mycli.domain.logging import ModelLogContext
from mycli.domain.model_events import ModelEventType
from mycli.infrastructure.openai_client import ModelResponseError
from mycli.infrastructure.openai_responses_client import OpenAIResponsesClient
from mycli.schemas.responses_protocol import (
    ResponsesCapabilityProfile,
    ResponsesContinuationState,
)
from mycli.services.workspace_log_service import WorkspaceLogService


class _FakeSdkPayload:
    def __init__(self, payload: dict[str, object]) -> None:
        self._payload = payload

    def to_dict(self) -> dict[str, object]:
        return dict(self._payload)


class _FakeResponsesApi:
    def __init__(self, *, handler=None) -> None:
        self._handler = handler or (lambda kwargs: {"id": "resp_default", "output": []})
        self.create_calls: list[dict[str, object]] = []

    def create(self, **kwargs):
        self.create_calls.append(kwargs)
        result = self._handler(kwargs)
        if isinstance(result, Exception):
            raise result
        if kwargs.get("stream") is True:
            if isinstance(result, _FakeSdkStream):
                return result
            return _FakeSdkStream(result)
        if isinstance(result, _FakeSdkPayload):
            return result
        if isinstance(result, dict):
            return _FakeSdkPayload(result)
        return result


class _FakeSdkStream:
    def __init__(self, events) -> None:
        self._events = events
        self.closed = False

    def __iter__(self):
        return iter(self._events)

    def close(self) -> None:
        self.closed = True


class _FakeOpenAISdkClient:
    def __init__(self, *, handler=None) -> None:
        self.responses_api = _FakeResponsesApi(handler=handler)
        self.responses = type(
            "_FakeResponsesNamespace",
            (),
            {"create": self.responses_api.create},
        )()


def _status_error(*, status_code: int, body: dict[str, object], url: str = "https://example.invalid/v1/responses"):
    request = httpx.Request("POST", url)
    response = httpx.Response(status_code, request=request, json=body)
    if status_code == 404:
        return NotFoundError(str(body), response=response, body=body)
    return BadRequestError(str(body), response=response, body=body)


def _connection_error(url: str = "https://example.invalid/v1/responses") -> APIConnectionError:
    return APIConnectionError(
        message="connection reset by peer",
        request=httpx.Request("POST", url),
    )


def _build_log_service(tmp_path: Path) -> WorkspaceLogService:
    return WorkspaceLogService(
        workspace_root=tmp_path,
        now_provider=lambda: datetime(2026, 4, 11, 12, 30, 45, tzinfo=timezone.utc),
    )


def test_openai_responses_client_posts_request_and_preserves_id_and_output(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(
        handler=lambda kwargs: {
            "id": "resp_123",
            "output": [
                {
                    "type": "function_call",
                    "name": "list_directory",
                    "arguments": "{\"path\":\".\"}",
                    "call_id": "call_001",
                }
            ],
        }
    )
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
        capability_profile=ResponsesCapabilityProfile(
            requires_assistant_output_text=True,
        ),
    )

    payload = client.create_response(
        input_items=[{"role": "user", "content": "inspect the repo"}],
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

    assert sdk_client.responses_api.create_calls == [{
        "model": "gpt-test",
        "input": [{"role": "user", "content": "inspect the repo"}],
        "tools": [
            {
                "type": "function",
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
            }
        ],
        "max_output_tokens": 2048,
    }]
    assert payload["id"] == "resp_123"
    assert payload["output"] == [
        {
            "type": "function_call",
            "name": "list_directory",
            "arguments": "{\"path\":\".\"}",
            "call_id": "call_001",
        }
    ]


def test_openai_responses_client_maps_output_payload_to_model_events(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(
        handler=lambda kwargs: {
            "id": "resp_123",
            "output": [
                {
                    "id": "fc_001",
                    "type": "function_call",
                    "name": "list_directory",
                    "arguments": "{\"path\":\".\"}",
                    "call_id": "call_001",
                },
                {
                    "id": "msg_001",
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "I can inspect the repository."}],
                },
            ],
        }
    )
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIResponsesClient(
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
        ModelEventType.TOOL_CALL_REQUESTED,
        ModelEventType.MESSAGE_DELTA,
        ModelEventType.TURN_COMPLETED,
    ]


def test_openai_responses_client_uses_openai_sdk_transport(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(
        handler=lambda kwargs: {
            "id": "resp_sdk_1",
            "output": [],
        }
    )

    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )

    payload = client.create_response(
        input_items=[{"role": "user", "content": "inspect the repo"}],
        tools=[],
    )

    assert sdk_client.responses_api.create_calls == [
        {
            "model": "gpt-test",
            "input": [{"role": "user", "content": "inspect the repo"}],
            "tools": [],
            "max_output_tokens": 2048,
        }
    ]
    assert payload["id"] == "resp_sdk_1"


def test_openai_responses_client_normalizes_assistant_input_text_to_output_text(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(handler=lambda kwargs: {"id": "resp_123", "output": []})
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
        capability_profile=ResponsesCapabilityProfile(
            requires_assistant_output_text=True,
        ),
    )

    client.create_response(
        input_items=[
            {
                "role": "assistant",
                "content": [{"type": "input_text", "text": "hello"}],
            }
        ],
        tools=[],
    )

    assert sdk_client.responses_api.create_calls[-1]["input"] == [
        {
            "role": "assistant",
            "content": [{"type": "output_text", "text": "hello"}],
        }
    ]


def test_openai_responses_client_normalizes_empty_function_call_output(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(handler=lambda kwargs: {"id": "resp_123", "output": []})
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
        capability_profile=ResponsesCapabilityProfile(
            disallows_empty_function_call_output=True,
        ),
    )

    client.create_response(
        input_items=[
            {
                "type": "function_call_output",
                "call_id": "call_123",
                "output": "",
            }
        ],
        tools=[],
    )

    assert sdk_client.responses_api.create_calls[-1]["input"] == [
        {
            "type": "function_call_output",
            "call_id": "call_123",
            "output": "Tool returned no output.",
        }
    ]


def test_openai_responses_client_uses_previous_response_id_when_continuation_matches(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        handler=lambda kwargs: [
            {
                "type": "response.completed",
                "response": {"id": "resp_456", "status": "completed"},
            }
        ]
    )
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )
    client.set_continuation_state(
        ResponsesContinuationState(
            response_id="resp_123",
            request_signature='{"max_output_tokens":2048,"model":"gpt-test","stream":true,"tools":[]}',
            request_input=(
                {
                    "role": "user",
                    "content": [{"type": "input_text", "text": "inspect"}],
                },
            ),
            response_output=(
                {
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "I will inspect."}],
                },
            ),
            eligible=True,
        )
    )

    list(
        client.stream_response(
            input_items=[
                {
                    "role": "user",
                    "content": [{"type": "input_text", "text": "inspect"}],
                },
                {
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "I will inspect."}],
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "README.md",
                },
            ],
            tools=[],
        )
    )

    assert sdk_client.responses_api.create_calls[-1]["previous_response_id"] == "resp_123"
    assert sdk_client.responses_api.create_calls[-1]["input"] == [
        {
            "type": "function_call_output",
            "call_id": "call_1",
            "output": "README.md",
        }
    ]


def test_openai_responses_client_includes_reasoning_effort_when_configured(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(handler=lambda kwargs: {"id": "resp_123", "output": []})
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )
    client.set_reasoning_effort("high")

    client.create_response(
        input_items=[{"role": "user", "content": "inspect the repo"}],
        tools=[],
    )

    assert sdk_client.responses_api.create_calls[-1]["reasoning"] == {"effort": "high"}


def test_openai_responses_client_omits_reasoning_payload_when_thinking_disabled(
    monkeypatch,
) -> None:
    sdk_client = _FakeOpenAISdkClient(handler=lambda kwargs: {"id": "resp_123", "output": []})
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )
    client.set_thinking_config(enabled=False, effort=None)

    client.create_response(
        input_items=[{"role": "user", "content": "inspect the repo"}],
        tools=[],
    )

    assert "reasoning" not in sdk_client.responses_api.create_calls[-1]


def test_openai_responses_client_serializes_update_plan_array_item_schema(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(handler=lambda kwargs: {"id": "resp_123", "output": []})
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )

    client.create_response(
        input_items=[{"role": "user", "content": "record plan"}],
        tools=[
            {
                "name": "update_plan",
                "description": "Replace the active plan with a structured list of pending and in-progress steps.",
                "parameters": [
                    {
                        "name": "items",
                        "type": "array",
                        "required": True,
                        "items_schema": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "content": {"type": "string"},
                                "description": {"type": "string"},
                                "status": {"type": "string"},
                            },
                            "required": ["status"],
                            "additionalProperties": False,
                        },
                    }
                ],
            }
        ],
    )

    assert sdk_client.responses_api.create_calls[-1]["tools"] == [
        {
            "type": "function",
            "name": "update_plan",
            "description": "Replace the active plan with a structured list of pending and in-progress steps.",
            "parameters": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "content": {"type": "string"},
                                "description": {"type": "string"},
                                "status": {"type": "string"},
                            },
                            "required": ["status"],
                            "additionalProperties": False,
                        },
                    }
                },
                "required": ["items"],
                "additionalProperties": False,
            },
        }
    ]


def test_openai_responses_client_serializes_run_shell_string_array_schema(monkeypatch) -> None:
    sdk_client = _FakeOpenAISdkClient(handler=lambda kwargs: {"id": "resp_123", "output": []})
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )

    client.create_response(
        input_items=[{"role": "user", "content": "run shell"}],
        tools=[
            {
                "name": "run_shell",
                "description": "Run a shell command in the workspace using a structured args list.",
                "parameters": [
                    {
                        "name": "args",
                        "type": "array",
                        "required": True,
                        "items_schema": {"type": "string"},
                    }
                ],
            }
        ],
    )

    assert sdk_client.responses_api.create_calls[-1]["tools"][0]["parameters"]["properties"]["args"] == {
        "type": "array",
        "items": {"type": "string"},
    }


def test_openai_responses_client_logs_request_and_response_payloads(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: _FakeOpenAISdkClient(handler=lambda kwargs: {"id": "resp_123", "output": []}),
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
        log_service=_build_log_service(tmp_path),
        log_context_provider=lambda: ModelLogContext(session_id="demo", turn_id="turn_1"),
    )

    client.create_response(
        input_items=[{"role": "user", "content": "inspect the repo"}],
        tools=[],
    )

    raw_dir = tmp_path / "log" / "model-raw"
    request_files = sorted(raw_dir.glob("*-request.json"))
    response_files = sorted(raw_dir.glob("*-response.json"))
    assert len(request_files) == 1
    assert len(response_files) == 1
    request_payload = json.loads(request_files[0].read_text(encoding="utf-8"))
    assert request_payload["body"]["model"] == "gpt-test"
    assert request_payload["continuation"]["decision"] == "missing_state"
    assert request_payload["continuation"]["previous_response_id"] is None
    assert "Authorization" not in json.dumps(request_payload, ensure_ascii=False)
    events = [
        json.loads(line)
        for line in (tmp_path / "log" / "model-events.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert [event["event"] for event in events] == [
        "model_request_started",
        "model_response_received",
    ]


def test_openai_responses_client_maps_unsupported_provider_error(monkeypatch) -> None:
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: _FakeOpenAISdkClient(
            handler=lambda kwargs: _status_error(
                status_code=404,
                body={"error": {"message": "route /responses not found"}},
            )
        ),
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )

    with pytest.raises(
        ModelResponseError,
        match="Use protocol='chat_completions'",
    ):
        client.create_response(
            input_items=[{"role": "user", "content": "inspect the repo"}],
            tools=[],
        )


def test_openai_responses_client_maps_invalid_json_response_to_model_response_error(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: _FakeOpenAISdkClient(handler=lambda kwargs: '{"id":"resp_123","output":'),
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )

    with pytest.raises(ModelResponseError, match="valid JSON"):
        client.create_response(
            input_items=[{"role": "user", "content": "inspect the repo"}],
            tools=[],
        )


def test_openai_responses_client_logs_transport_errors(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: _FakeOpenAISdkClient(handler=lambda kwargs: _connection_error()),
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
        log_service=_build_log_service(tmp_path),
        log_context_provider=lambda: ModelLogContext(session_id="demo", turn_id="turn_2"),
    )

    with pytest.raises(ModelResponseError, match="Failed to reach model provider"):
        client.create_response(
            input_items=[{"role": "user", "content": "inspect the repo"}],
            tools=[],
        )

    error_files = sorted((tmp_path / "log" / "model-raw").glob("*-error.json"))
    assert len(error_files) == 1
    error_payload = json.loads(error_files[0].read_text(encoding="utf-8"))
    assert error_payload["error_type"] == "APIConnectionError"
    events = [
        json.loads(line)
        for line in (tmp_path / "log" / "model-events.jsonl").read_text(encoding="utf-8").splitlines()
    ]
    assert events[-1]["event"] == "model_request_failed"


def test_openai_responses_client_logs_invalid_json_errors(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: _FakeOpenAISdkClient(handler=lambda kwargs: '{"id":"resp_123","output":'),
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
        log_service=_build_log_service(tmp_path),
        log_context_provider=lambda: ModelLogContext(session_id="demo", turn_id="turn_3"),
    )

    with pytest.raises(ModelResponseError, match="valid JSON"):
        client.create_response(
            input_items=[{"role": "user", "content": "inspect the repo"}],
            tools=[],
        )

    error_files = sorted((tmp_path / "log" / "model-raw").glob("*-error.json"))
    assert len(error_files) == 1
    error_payload = json.loads(error_files[0].read_text(encoding="utf-8"))
    assert error_payload["error_type"] == "TypeError"


def test_openai_responses_client_streams_provider_events(
    monkeypatch,
    tmp_path: Path,
) -> None:
    sdk_client = _FakeOpenAISdkClient(
        handler=lambda kwargs: [
            {
                "type": "response.reasoning_summary_text.delta",
                "item_id": "rs_1",
                "output_index": 0,
                "summary_index": 0,
                "delta": "Inspect pyproject first.",
            },
            {
                "type": "response.output_text.delta",
                "item_id": "msg_1",
                "output_index": 1,
                "content_index": 0,
                "delta": "Repository ",
            },
            {
                "type": "response.function_call_arguments.done",
                "item_id": "fc_1",
                "output_index": 2,
                "name": "read_file",
                "arguments": '{"path":"pyproject.toml"}',
                "call_id": "call_read_1",
            },
            {
                "type": "response.completed",
                "response": {"id": "resp_123", "status": "completed"},
            },
        ]
    )
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: sdk_client,
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
        log_service=_build_log_service(tmp_path),
        log_context_provider=lambda: ModelLogContext(session_id="demo", turn_id="turn_stream_1"),
    )

    events = list(
        client.stream_response(
            input_items=[{"role": "user", "content": "inspect"}],
            tools=[],
        )
    )

    assert sdk_client.responses_api.create_calls[-1]["stream"] is True
    assert events[0]["type"] == "response.reasoning_summary_text.delta"
    assert events[-1]["type"] == "response.completed"
    app_log = (tmp_path / "log" / "app.log").read_text(encoding="utf-8")
    assert "model_stream_started" in app_log


def test_openai_responses_client_logs_stream_parse_errors(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: _FakeOpenAISdkClient(handler=lambda kwargs: [b"data: {invalid json}\n\n"]),
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
        log_service=_build_log_service(tmp_path),
        log_context_provider=lambda: ModelLogContext(session_id="demo", turn_id="turn_stream_error_1"),
    )

    with pytest.raises(ModelResponseError, match="valid JSON stream events"):
        list(
            client.stream_response(
                input_items=[{"role": "user", "content": "inspect"}],
                tools=[],
            )
        )

    error_files = sorted((tmp_path / "log" / "model-raw").glob("*-error.json"))
    assert len(error_files) == 1
    error_payload = json.loads(error_files[0].read_text(encoding="utf-8"))
    assert error_payload["error_type"] == "JSONDecodeError"


def test_openai_responses_client_surfaces_provider_name_in_http_error(monkeypatch) -> None:
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: _FakeOpenAISdkClient(
            handler=lambda kwargs: _status_error(
                status_code=500,
                body={"error": {"message": "upstream overloaded"}},
            )
        ),
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )

    with pytest.raises(ModelResponseError) as exc:
        client.create_response(
            input_items=[{"role": "user", "content": "inspect the repo"}],
            tools=[],
        )

    assert "provider 'example.invalid'" in str(exc.value)


def test_openai_responses_client_maps_transport_error_to_model_response_error(monkeypatch) -> None:
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: _FakeOpenAISdkClient(handler=lambda kwargs: _connection_error()),
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )

    with pytest.raises(ModelResponseError, match="Failed to reach model provider"):
        client.create_response(
            input_items=[{"role": "user", "content": "inspect the repo"}],
            tools=[],
        )


def test_openai_responses_client_retries_stream_transport_failures(monkeypatch) -> None:
    attempts = 0

    def handler(kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return _connection_error()
        return [
            {
                "type": "response.completed",
                "response": {"id": "resp_retry_1", "status": "completed"},
            }
        ]

    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: _FakeOpenAISdkClient(handler=handler),
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
        capability_profile=ResponsesCapabilityProfile(stream_max_retries=1),
    )

    events = list(
        client.stream_response(
            input_items=[{"role": "user", "content": "inspect"}],
            tools=[],
        )
    )

    assert attempts == 2
    assert events[-1]["type"] == "response.completed"


def test_openai_responses_client_marks_retry_exhausted_when_stream_retry_budget_is_spent(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: _FakeOpenAISdkClient(handler=lambda kwargs: _connection_error()),
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
        capability_profile=ResponsesCapabilityProfile(
            stream_max_retries=1,
            supports_stream_fallback_to_create=False,
        ),
    )

    with pytest.raises(ModelResponseError) as exc:
        list(
            client.stream_response(
                input_items=[{"role": "user", "content": "inspect"}],
                tools=[],
            )
        )

    assert exc.value.stop_reason is StopReason.RETRY_EXHAUSTED
    assert exc.value.is_retryable is False
    assert exc.value.failure_kind == "retry_exhausted"


def test_openai_responses_client_falls_back_to_create_after_stream_retry_exhaustion(
    monkeypatch,
) -> None:
    request_bodies: list[dict[str, object]] = []

    def handler(kwargs):
        request_bodies.append(dict(kwargs))
        if kwargs.get("stream") is True:
            return _connection_error()
        return {
            "id": "resp_fallback_1",
            "output": [
                {
                    "id": "msg_1",
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "Fallback answer",
                        }
                    ],
                }
            ],
        }

    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: _FakeOpenAISdkClient(handler=handler),
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
        capability_profile=ResponsesCapabilityProfile(stream_max_retries=0),
    )

    events = list(
        client.stream_response(
            input_items=[{"role": "user", "content": "inspect"}],
            tools=[],
        )
    )

    assert [body.get("stream", False) for body in request_bodies] == [True, False]
    assert events[0]["type"] == "response.output_text.delta"
    assert events[0]["delta"] == "Fallback answer"
    assert events[-1]["type"] == "response.completed"
    assert events[-1]["response"]["id"] == "resp_fallback_1"


def test_openai_responses_client_stream_retries_without_previous_response_id_when_provider_breaks_continuation_with_502(
    monkeypatch,
) -> None:
    request_bodies: list[dict[str, object]] = []

    def handler(kwargs):
        request_bodies.append(dict(kwargs))
        if kwargs.get("previous_response_id") == "resp_prev_1":
            return _status_error(
                status_code=502,
                body={"error": {"message": "Upstream request failed"}},
            )
        return [
            {
                "type": "response.completed",
                "response": {"id": "resp_stream_retry_1", "status": "completed"},
            }
        ]

    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: _FakeOpenAISdkClient(handler=handler),
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )
    client.set_continuation_state(
        ResponsesContinuationState(
            response_id="resp_prev_1",
            request_signature='{"max_output_tokens":2048,"model":"gpt-test","stream":true,"tools":[]}',
            request_input=(
                {
                    "role": "user",
                    "content": [{"type": "input_text", "text": "inspect"}],
                },
            ),
            response_output=(
                {
                    "type": "function_call",
                    "name": "inspect_repo",
                    "arguments": "{\"path\":\".\"}",
                    "call_id": "call_1",
                },
            ),
            eligible=True,
        )
    )

    events = list(
        client.stream_response(
            input_items=[
                {"role": "user", "content": "inspect"},
                {
                    "type": "function_call",
                    "name": "inspect_repo",
                    "arguments": "{\"path\":\".\"}",
                    "call_id": "call_1",
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "README.md",
                },
            ],
            tools=[],
        )
    )

    assert events[-1]["type"] == "response.completed"
    assert request_bodies[0]["stream"] is True
    assert request_bodies[0]["previous_response_id"] == "resp_prev_1"
    assert request_bodies[1]["stream"] is True
    assert "previous_response_id" not in request_bodies[1]
    assert request_bodies[1]["input"] == [
        {"role": "user", "content": "inspect"},
        {
            "type": "function_call",
            "name": "inspect_repo",
            "arguments": "{\"path\":\".\"}",
            "call_id": "call_1",
        },
        {
            "type": "function_call_output",
            "call_id": "call_1",
            "output": "README.md",
        },
    ]


def test_openai_responses_client_maps_context_window_failures_to_structured_stop_reason(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: _FakeOpenAISdkClient(
            handler=lambda kwargs: _status_error(
                status_code=400,
                body={"error": {"message": "maximum context length exceeded"}},
            )
        ),
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )

    with pytest.raises(ModelResponseError) as exc:
        client.create_response(
            input_items=[{"role": "user", "content": "inspect the repo"}],
            tools=[],
        )

    assert exc.value.stop_reason is StopReason.CONTEXT_WINDOW_EXCEEDED
    assert exc.value.is_retryable is False
    assert exc.value.failure_kind == "context_window_exceeded"


def test_openai_responses_client_retries_without_previous_response_id_when_provider_rejects_continuation(
    monkeypatch,
) -> None:
    request_bodies: list[dict[str, object]] = []

    def handler(kwargs):
        request_bodies.append(dict(kwargs))
        if kwargs.get("previous_response_id") == "resp_prev_1":
            return _status_error(
                status_code=400,
                body={"error": {"message": "previous_response_id resp_prev_1 was not found"}},
            )
        return {"id": "resp_new_1", "output": []}

    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: _FakeOpenAISdkClient(handler=handler),
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )
    client.set_continuation_state(
        ResponsesContinuationState(
            response_id="resp_prev_1",
            request_signature='{"max_output_tokens":2048,"model":"gpt-test","stream":false,"tools":[]}',
            request_input=(
                {
                    "role": "user",
                    "content": [{"type": "input_text", "text": "inspect"}],
                },
            ),
            response_output=(
                {
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "I will inspect."}],
                },
            ),
            eligible=True,
        )
    )

    payload = client.create_response(
        input_items=[
            {"role": "user", "content": "inspect"},
            {
                "role": "assistant",
                "content": [{"type": "output_text", "text": "I will inspect."}],
            },
            {
                "type": "function_call_output",
                "call_id": "call_1",
                "output": "README.md",
            },
        ],
        tools=[],
    )

    assert payload["id"] == "resp_new_1"
    assert request_bodies[0]["previous_response_id"] == "resp_prev_1"
    assert "previous_response_id" not in request_bodies[1]


def test_openai_responses_client_retries_without_previous_response_id_when_provider_breaks_continuation_with_502(
    monkeypatch,
) -> None:
    request_bodies: list[dict[str, object]] = []

    def handler(kwargs):
        request_bodies.append(dict(kwargs))
        if kwargs.get("previous_response_id") == "resp_prev_1":
            return _status_error(
                status_code=502,
                body={"error": {"message": "Upstream request failed"}},
            )
        return {"id": "resp_new_502", "output": []}

    monkeypatch.setattr(
        "mycli.infrastructure.openai_responses_client._build_openai_sdk_client",
        lambda **_: _FakeOpenAISdkClient(handler=handler),
    )

    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )
    client.set_continuation_state(
        ResponsesContinuationState(
            response_id="resp_prev_1",
            request_signature='{"max_output_tokens":2048,"model":"gpt-test","stream":false,"tools":[]}',
            request_input=(
                {
                    "role": "user",
                    "content": [{"type": "input_text", "text": "inspect"}],
                },
            ),
            response_output=(
                {
                    "type": "function_call",
                    "name": "inspect_repo",
                    "arguments": "{\"path\":\".\"}",
                    "call_id": "call_1",
                },
            ),
            eligible=True,
        )
    )

    payload = client.create_response(
        input_items=[
            {"role": "user", "content": "inspect"},
            {
                "type": "function_call",
                "name": "inspect_repo",
                "arguments": "{\"path\":\".\"}",
                "call_id": "call_1",
            },
            {
                "type": "function_call_output",
                "call_id": "call_1",
                "output": "README.md",
            },
        ],
        tools=[],
    )

    assert payload["id"] == "resp_new_502"
    assert request_bodies[0]["previous_response_id"] == "resp_prev_1"
    assert "previous_response_id" not in request_bodies[1]
    assert request_bodies[1]["input"] == [
        {"role": "user", "content": "inspect"},
        {
            "type": "function_call",
            "name": "inspect_repo",
            "arguments": "{\"path\":\".\"}",
            "call_id": "call_1",
        },
        {
            "type": "function_call_output",
            "call_id": "call_1",
            "output": "README.md",
        },
    ]


def test_openai_responses_client_preserves_previous_continuation_state_when_tool_result_followup_fails() -> None:
    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )
    client.set_continuation_state(
        ResponsesContinuationState(
            response_id="resp_prev_1",
            request_signature='{"max_output_tokens":2048,"model":"gpt-test","stream":false,"tools":[]}',
            request_input=(
                {"role": "user", "content": [{"type": "input_text", "text": "inspect"}]},
            ),
            response_output=(),
            eligible=True,
        )
    )
    client._pending_request_signature = "pending_sig"
    client._pending_request_input = (
        {"type": "function_call_output", "call_id": "call_1", "output": "README.md"},
        {"role": "user", "content": [{"type": "input_text", "text": "continue"}]},
    )

    client.record_response_failure("provider failure")

    state = client.get_continuation_state()
    assert state is not None
    assert state.response_id == "resp_prev_1"
    assert state.eligible is True
    assert state.failure_reason == "provider failure"


def test_openai_responses_client_marks_pending_continuation_ineligible_when_failure_has_no_tool_result() -> None:
    client = OpenAIResponsesClient(
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="gpt-test",
        max_output_tokens=2048,
    )
    client._pending_request_signature = "pending_sig"
    client._pending_request_input = (
        {"role": "user", "content": [{"type": "input_text", "text": "inspect"}]},
    )

    client.record_response_failure("provider failure")

    state = client.get_continuation_state()
    assert state is not None
    assert state.response_id is None
    assert state.eligible is False
    assert state.failure_reason == "provider failure"
