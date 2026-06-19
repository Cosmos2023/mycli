from __future__ import annotations

import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import anthropic
import httpx
import pytest

from mycli.domain.logging import ModelLogContext
from mycli.domain.runtime import ReasoningEffort, RuntimeInterruptToken, StopReason
from mycli.llms.clients.anthropic_messages import (
    AnthropicMessagesClient,
    _build_anthropic_sdk_client,
    classify_anthropic_provider_failure,
)
from mycli.llms.clients.openai_chat import ModelResponseError
from mycli.utils.workspace_logger import WorkspaceLogService


class FakeMessagesResource:
    def __init__(
        self,
        payload: dict[str, object],
        error: Exception | None = None,
    ) -> None:
        self.payload = payload
        self.error = error
        self.kwargs: dict[str, object] = {}

    def create(self, **kwargs: object) -> dict[str, object]:
        self.kwargs = dict(kwargs)
        if self.error is not None:
            raise self.error
        return self.payload


class FakeMessagesStreamResource(FakeMessagesResource):
    def __init__(self) -> None:
        super().__init__({"id": "unused", "content": []})

    def stream(self, **kwargs: object):
        self.kwargs = dict(kwargs)
        return iter(
            [
                {
                    "type": "content_block_delta",
                    "delta": {"type": "thinking_delta", "thinking": "Thinking."},
                },
                {
                    "type": "content_block_delta",
                    "delta": {"type": "text_delta", "text": "hello "},
                },
                {
                    "type": "content_block_delta",
                    "delta": {
                        "type": "input_json_delta",
                        "partial_json": '{"file_path":"README.md"}',
                    },
                    "index": 1,
                },
                {
                    "type": "content_block_stop",
                    "index": 1,
                    "content_block": {
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "Read",
                        "input": {"file_path": "README.md"},
                    },
                },
                {
                    "type": "message_stop",
                    "message": {
                        "id": "msg_stream_1",
                        "usage": {"input_tokens": 9, "output_tokens": 2},
                    },
                },
            ]
        )


class FakeAnthropicSdkClient:
    def __init__(
        self,
        payload: dict[str, object],
        error: Exception | None = None,
    ) -> None:
        self.messages = FakeMessagesResource(payload, error)
        self.closed = False

    def close(self) -> None:
        self.closed = True


class FakeAnthropicStreamingSdkClient:
    def __init__(self) -> None:
        self.messages = FakeMessagesStreamResource()
        self.closed = False

    def close(self) -> None:
        self.closed = True


class BlockingMessagesStreamResource(FakeMessagesResource):
    def __init__(self) -> None:
        super().__init__({"id": "unused", "content": []})
        self.started = threading.Event()
        self.release = threading.Event()

    def stream(self, **kwargs: object):
        self.kwargs = dict(kwargs)
        self.started.set()
        self.release.wait(timeout=30)
        return iter([])


class BlockingAnthropicStreamingSdkClient:
    def __init__(self) -> None:
        self.messages = BlockingMessagesStreamResource()
        self.closed = False

    def close(self) -> None:
        self.closed = True


def _build_log_service(tmp_path: Path) -> WorkspaceLogService:
    return WorkspaceLogService(
        workspace_root=tmp_path,
        now_provider=lambda: datetime(2026, 4, 26, 12, 30, 45, tzinfo=timezone.utc),
    )


def _status_error(*, status_code: int, body: dict[str, object]) -> anthropic.APIStatusError:
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx.Response(status_code, request=request, json=body)
    return anthropic.BadRequestError(str(body), response=response, body=body)


def test_anthropic_client_builds_messages_request_with_thinking(
    tmp_path: Path,
) -> None:
    sdk_client = FakeAnthropicSdkClient(
        {
            "id": "msg_1",
            "role": "assistant",
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
        }
    )
    client = AnthropicMessagesClient(
        api_key="test-key",
        base_url="https://api.anthropic.com",
        model="claude-sonnet-4-6",
        max_output_tokens=4096,
        log_service=_build_log_service(tmp_path),
        sdk_client=sdk_client,
    )
    client.set_log_context_provider(lambda: ModelLogContext(session_id="s1", turn_id="t1"))
    client.set_thinking_config(enabled=True, effort=ReasoningEffort.MEDIUM)

    payload = client.create_message(
        system="System rules.",
        messages=[{"role": "user", "content": [{"type": "text", "text": "Hi"}]}],
        tools=[{"name": "read_file", "description": "Read", "input_schema": {"type": "object"}}],
    )

    assert payload["id"] == "msg_1"
    assert sdk_client.messages.kwargs["model"] == "claude-sonnet-4-6"
    assert sdk_client.messages.kwargs["system"] == "System rules."
    assert sdk_client.messages.kwargs["max_tokens"] == 4096
    assert sdk_client.messages.kwargs["messages"] == [
        {"role": "user", "content": [{"type": "text", "text": "Hi"}]}
    ]
    assert sdk_client.messages.kwargs["tools"] == [
        {"name": "read_file", "description": "Read", "input_schema": {"type": "object"}}
    ]
    assert sdk_client.messages.kwargs["thinking"] == {
        "type": "enabled",
        "budget_tokens": 1536,
    }
    assert list((tmp_path / "log" / "model-raw").glob("*/*-request.json"))
    assert list((tmp_path / "log" / "model-raw").glob("*/*-response.json"))


def test_anthropic_client_stream_message_normalizes_events(tmp_path: Path) -> None:
    sdk_client = FakeAnthropicStreamingSdkClient()
    client = AnthropicMessagesClient(
        api_key="test-key",
        base_url="https://api.anthropic.com",
        model="claude-sonnet-4-6",
        max_output_tokens=4096,
        log_service=_build_log_service(tmp_path),
        sdk_client=sdk_client,
    )

    events = list(
        client.stream_message(
            system=None,
            messages=[{"role": "user", "content": [{"type": "text", "text": "Hi"}]}],
            tools=[],
        )
    )

    assert [event["type"] for event in events] == [
        "reasoning",
        "text_delta",
        "tool_call",
        "completed",
    ]
    assert events[0]["text"] == "Thinking."
    assert events[1]["text"] == "hello "
    assert events[2]["block"].tool_name == "Read"
    assert events[3]["response_id"] == "msg_stream_1"
    assert events[3]["metadata"] == {"usage": {"input_tokens": 9, "output_tokens": 2}}


def test_anthropic_client_closes_sdk_client_when_interrupted_before_stream_exists(
    tmp_path: Path,
) -> None:
    token = RuntimeInterruptToken()
    sdk_client = BlockingAnthropicStreamingSdkClient()
    client = AnthropicMessagesClient(
        api_key="test-key",
        base_url="https://api.anthropic.com",
        model="claude-sonnet-4-6",
        max_output_tokens=4096,
        log_service=_build_log_service(tmp_path),
        sdk_client=sdk_client,
    )

    def consume() -> None:
        list(
            client.stream_message_with_interrupt(
                system=None,
                messages=[{"role": "user", "content": [{"type": "text", "text": "Hi"}]}],
                tools=[],
                interrupt_token=token,
            )
        )

    thread = threading.Thread(target=consume)
    thread.start()
    assert sdk_client.messages.started.wait(timeout=1.0)
    token.request("test_interrupt")
    try:
        assert sdk_client.closed is True
    finally:
        sdk_client.messages.release.set()
        thread.join(timeout=3.0)


def test_anthropic_client_disables_thinking_explicitly(tmp_path: Path) -> None:
    sdk_client = FakeAnthropicSdkClient(
        {
            "id": "msg_2",
            "role": "assistant",
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
        }
    )
    client = AnthropicMessagesClient(
        api_key="test-key",
        base_url="https://api.anthropic.com",
        model="claude-sonnet-4-6",
        max_output_tokens=2048,
        log_service=_build_log_service(tmp_path),
        sdk_client=sdk_client,
    )
    client.set_thinking_config(enabled=False, effort=None)

    client.create_message(system=None, messages=[], tools=[])

    assert sdk_client.messages.kwargs["thinking"] == {"type": "disabled"}


def test_anthropic_client_high_thinking_fits_4096_max_tokens(
    tmp_path: Path,
) -> None:
    sdk_client = FakeAnthropicSdkClient(
        {
            "id": "msg_high",
            "role": "assistant",
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
        }
    )
    client = AnthropicMessagesClient(
        api_key="test-key",
        base_url="https://api.anthropic.com",
        model="claude-sonnet-4-6",
        max_output_tokens=4096,
        log_service=_build_log_service(tmp_path),
        sdk_client=sdk_client,
    )
    client.set_thinking_config(enabled=True, effort=ReasoningEffort.HIGH)

    client.create_message(system=None, messages=[], tools=[])

    assert sdk_client.messages.kwargs["thinking"] == {
        "type": "enabled",
        "budget_tokens": 3072,
    }


def test_anthropic_client_xhigh_thinking_requires_more_than_6144_max_tokens(
    tmp_path: Path,
) -> None:
    sdk_client = FakeAnthropicSdkClient(
        {
            "id": "msg_xhigh",
            "role": "assistant",
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
        }
    )
    client = AnthropicMessagesClient(
        api_key="test-key",
        base_url="https://api.anthropic.com",
        model="claude-sonnet-4-6",
        max_output_tokens=4096,
        log_service=_build_log_service(tmp_path),
        sdk_client=sdk_client,
    )
    client.set_thinking_config(enabled=True, effort=ReasoningEffort.XHIGH)

    with pytest.raises(ModelResponseError, match="budget=6144"):
        client.create_message(system=None, messages=[], tools=[])


def test_anthropic_client_rejects_thinking_budget_that_exceeds_max_tokens(
    tmp_path: Path,
) -> None:
    sdk_client = FakeAnthropicSdkClient(
        {
            "id": "msg_3",
            "role": "assistant",
            "content": [{"type": "text", "text": "ok"}],
            "stop_reason": "end_turn",
        }
    )
    client = AnthropicMessagesClient(
        api_key="test-key",
        base_url="https://api.anthropic.com",
        model="claude-sonnet-4-6",
        max_output_tokens=1024,
        log_service=_build_log_service(tmp_path),
        sdk_client=sdk_client,
    )
    client.set_thinking_config(enabled=True, effort=ReasoningEffort.MEDIUM)

    with pytest.raises(ModelResponseError, match="thinking budget"):
        client.create_message(system=None, messages=[], tools=[])


def test_anthropic_client_maps_status_errors(tmp_path: Path) -> None:
    sdk_client = FakeAnthropicSdkClient(
        {},
        error=_status_error(
            status_code=400,
            body={"error": {"message": "invalid request"}},
        ),
    )
    client = AnthropicMessagesClient(
        api_key="test-key",
        base_url="https://api.anthropic.com",
        model="claude-sonnet-4-6",
        max_output_tokens=2048,
        log_service=_build_log_service(tmp_path),
        sdk_client=sdk_client,
    )

    with pytest.raises(ModelResponseError) as exc_info:
        client.create_message(system=None, messages=[], tools=[])

    assert "HTTP 400" in str(exc_info.value)
    assert "invalid request" in str(exc_info.value)
    assert exc_info.value.failure_kind == "provider_error"
    assert exc_info.value.is_retryable is False
    assert list((tmp_path / "log" / "model-raw").glob("*/*-error.json"))


def test_build_anthropic_sdk_client_uses_configured_base_url() -> None:
    client = _build_anthropic_sdk_client(
        api_key="test-key",
        base_url="https://api.anthropic.com",
    )

    assert isinstance(client, anthropic.Anthropic)


def test_anthropic_client_accepts_sdk_payload_model_dump(tmp_path: Path) -> None:
    class Payload:
        def model_dump(self) -> dict[str, Any]:
            return {"id": "msg_dump", "content": [{"type": "text", "text": "ok"}]}

    class Messages:
        kwargs: dict[str, object]

        def create(self, **kwargs: object) -> Payload:
            self.kwargs = dict(kwargs)
            return Payload()

    class Sdk:
        def __init__(self) -> None:
            self.messages = Messages()

    client = AnthropicMessagesClient(
        api_key="test-key",
        base_url="https://api.anthropic.com",
        model="claude-sonnet-4-6",
        max_output_tokens=2048,
        log_service=_build_log_service(tmp_path),
        sdk_client=Sdk(),
    )

    assert client.create_message(system=None, messages=[], tools=[]) == {
        "id": "msg_dump",
        "content": [{"type": "text", "text": "ok"}],
    }


def test_anthropic_status_errors_use_shared_failure_taxonomy() -> None:
    classification = classify_anthropic_provider_failure(
        detail="overloaded",
        status_code=529,
        provider_error_code=None,
    )

    assert classification.stop_reason is StopReason.RATE_LIMITED
    assert classification.failure_kind == "provider_overloaded"
    assert classification.is_retryable is True


def test_anthropic_status_error_sets_model_response_recovery_fields(tmp_path: Path) -> None:
    client = AnthropicMessagesClient(
        api_key="test",
        base_url="https://api.anthropic.test",
        model="test-model",
        max_output_tokens=128,
        log_service=WorkspaceLogService(workspace_root=tmp_path),
    )
    exc = _status_error(status_code=529, body={"error": {"message": "overloaded"}})

    error = client._status_error(exc=exc, request_path=None)

    assert error.stop_reason is StopReason.RATE_LIMITED
    assert error.failure_kind == "provider_overloaded"
    assert error.is_retryable is True
