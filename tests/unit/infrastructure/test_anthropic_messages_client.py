from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import anthropic
import httpx
import pytest

from mycli.domain.logging import ModelLogContext
from mycli.domain.runtime import ReasoningEffort
from mycli.infrastructure.anthropic_messages_client import (
    AnthropicMessagesClient,
    _build_anthropic_sdk_client,
)
from mycli.infrastructure.openai_client import ModelResponseError
from mycli.services.workspace_log_service import WorkspaceLogService


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


class FakeAnthropicSdkClient:
    def __init__(
        self,
        payload: dict[str, object],
        error: Exception | None = None,
    ) -> None:
        self.messages = FakeMessagesResource(payload, error)


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
    assert list((tmp_path / "log" / "model-raw").glob("*-request.json"))
    assert list((tmp_path / "log" / "model-raw").glob("*-response.json"))


def test_anthropic_client_omits_thinking_when_disabled(tmp_path: Path) -> None:
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

    assert "thinking" not in sdk_client.messages.kwargs


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
    assert list((tmp_path / "log" / "model-raw").glob("*-error.json"))


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
