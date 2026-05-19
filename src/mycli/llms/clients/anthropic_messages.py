from __future__ import annotations

import json
from collections.abc import Callable, Iterator
from typing import Any, cast

from anthropic import (
    APIConnectionError,
    APIResponseValidationError,
    APIStatusError,
    APITimeoutError,
    Anthropic,
)

from mycli.domain.logging import LogLevel, ModelLogContext, ModelLogEvent
from mycli.domain.runtime import RuntimeBlock, StopReason
from mycli.llms.clients.openai_chat import ModelResponseError
from mycli.infrastructure.ssl import ensure_certifi_ca_bundle
from mycli.utils.workspace_logger import WorkspaceLogService

DEFAULT_ANTHROPIC_SDK_TIMEOUT_SECONDS = 60.0

_THINKING_BUDGETS: dict[str, int] = {
    "low": 1024,
    "medium": 1536,
    "high": 3072,
    "xhigh": 6144,
}


def _build_anthropic_sdk_client(*, api_key: str, base_url: str) -> Anthropic:
    return Anthropic(
        api_key=api_key,
        base_url=base_url,
        timeout=DEFAULT_ANTHROPIC_SDK_TIMEOUT_SECONDS,
        max_retries=0,
    )


def _payload_to_dict(payload: object) -> dict[str, object]:
    if isinstance(payload, dict):
        return dict(payload)
    for attr in ("to_dict", "model_dump", "dict"):
        serializer = getattr(payload, attr, None)
        if callable(serializer):
            serialized = serializer()
            if isinstance(serialized, dict):
                return dict(serialized)
    raise TypeError("Anthropic SDK payload must serialize to a dictionary.")


def _api_status_error_detail(exc: APIStatusError) -> str:
    body = exc.body
    if isinstance(body, dict):
        error_payload = body.get("error")
        if isinstance(error_payload, dict):
            message = error_payload.get("message")
            if isinstance(message, str) and message.strip():
                return message
        message = body.get("message")
        if isinstance(message, str) and message.strip():
            return message
        return json.dumps(body, ensure_ascii=False)
    if isinstance(body, str) and body.strip():
        return body
    return str(exc)


class AnthropicMessagesClient:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        max_output_tokens: int,
        log_service: WorkspaceLogService | None = None,
        log_context_provider: Callable[[], ModelLogContext] | None = None,
        sdk_client: object | None = None,
    ) -> None:
        ensure_certifi_ca_bundle()
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._max_output_tokens = max_output_tokens
        self._log_service = log_service
        self._log_context_provider = log_context_provider
        self._thinking_enabled = True
        self._thinking_effort: str | None = None
        self._sdk_client = sdk_client or _build_anthropic_sdk_client(
            api_key=api_key,
            base_url=base_url,
        )

    def set_log_context_provider(
        self,
        provider: Callable[[], ModelLogContext],
    ) -> None:
        self._log_context_provider = provider

    def set_thinking_config(self, *, enabled: bool, effort: object) -> None:
        self._thinking_enabled = enabled
        value = getattr(effort, "value", effort)
        self._thinking_effort = str(value) if enabled and value is not None else None

    def set_model(self, model: str) -> None:
        self._model = model

    def set_max_output_tokens(self, value: int) -> None:
        self._max_output_tokens = value

    def create_message(
        self,
        *,
        system: str | None,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> dict[str, object]:
        payload_body = self._message_payload_body(
            system=system,
            messages=messages,
            tools=tools,
        )
        request_path = self._log_request(payload_body)
        try:
            payload = _payload_to_dict(
                cast(Any, self._sdk_client).messages.create(**payload_body)
            )
        except APIStatusError as exc:
            raise self._status_error(exc=exc, request_path=request_path) from exc
        except (APIConnectionError, APITimeoutError) as exc:
            detail = str(exc)
            error_path = self._log_failure(
                message=detail,
                request_path=request_path,
                payload={"error_type": type(exc).__name__, "message": detail},
            )
            raise ModelResponseError(
                f"Failed to reach Anthropic provider: {detail}",
                error_path=error_path,
                log_path=self._default_error_log_path(),
                stop_reason=StopReason.MODEL_ERROR,
                is_retryable=True,
                failure_kind="provider_connection_error",
            ) from exc
        except (APIResponseValidationError, TypeError) as exc:
            detail = str(exc)
            response_body = exc.body if isinstance(exc, APIResponseValidationError) else None
            error_path = self._log_failure(
                message=detail,
                request_path=request_path,
                payload={
                    "error_type": type(exc).__name__,
                    "message": detail,
                    "response_body": response_body,
                },
            )
            raise ModelResponseError(
                "Anthropic provider response did not serialize to a JSON object.",
                error_path=error_path,
                log_path=self._default_error_log_path(),
                stop_reason=StopReason.MODEL_ERROR,
                failure_kind="provider_response_parse_error",
            ) from exc
        self._log_service_event(
            level=LogLevel.INFO,
            event="model_response_received",
            message="Received Anthropic Messages response",
            request_path=request_path,
            response_path=self._log_response(payload),
        )
        return payload

    def stream_message(
        self,
        *,
        system: str | None,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> Iterator[dict[str, object]]:
        payload_body = self._message_payload_body(
            system=system,
            messages=messages,
            tools=tools,
        )
        request_path = self._log_request(payload_body)
        try:
            stream = cast(Any, self._sdk_client).messages.stream(**payload_body)
            yield from self._events_from_message_stream(stream)
        except APIStatusError as exc:
            raise self._status_error(exc=exc, request_path=request_path) from exc
        except (APIConnectionError, APITimeoutError) as exc:
            detail = str(exc)
            error_path = self._log_failure(
                message=detail,
                request_path=request_path,
                payload={"error_type": type(exc).__name__, "message": detail},
            )
            raise ModelResponseError(
                f"Failed to reach Anthropic provider: {detail}",
                error_path=error_path,
                log_path=self._default_error_log_path(),
                stop_reason=StopReason.MODEL_ERROR,
                is_retryable=True,
                failure_kind="provider_connection_error",
            ) from exc
        except (APIResponseValidationError, TypeError) as exc:
            detail = str(exc)
            response_body = exc.body if isinstance(exc, APIResponseValidationError) else None
            error_path = self._log_failure(
                message=detail,
                request_path=request_path,
                payload={
                    "error_type": type(exc).__name__,
                    "message": detail,
                    "response_body": response_body,
                },
            )
            raise ModelResponseError(
                "Anthropic provider stream did not serialize to JSON objects.",
                error_path=error_path,
                log_path=self._default_error_log_path(),
                stop_reason=StopReason.MODEL_ERROR,
                failure_kind="provider_response_parse_error",
            ) from exc
        self._log_service_event(
            level=LogLevel.INFO,
            event="model_response_received",
            message="Received Anthropic Messages stream",
            request_path=request_path,
        )

    def _message_payload_body(
        self,
        *,
        system: str | None,
        messages: list[dict[str, object]],
        tools: list[dict[str, object]],
    ) -> dict[str, object]:
        payload_body: dict[str, object] = {
            "model": self._model,
            "max_tokens": self._max_output_tokens,
            "messages": messages,
        }
        if system is not None:
            payload_body["system"] = system
        if tools:
            payload_body["tools"] = tools
        thinking = self._thinking_payload()
        if thinking is not None:
            payload_body["thinking"] = thinking
        return payload_body

    def _events_from_message_stream(
        self,
        stream: object,
    ) -> Iterator[dict[str, object]]:
        input_json_by_index: dict[int, str] = {}
        response_id: str | None = None
        usage: dict[str, object] | None = None
        for event in self._iter_stream_payloads(stream):
            payload = _payload_to_dict(event)
            event_type = payload.get("type")
            if event_type == "content_block_delta":
                delta = payload.get("delta")
                if not isinstance(delta, dict):
                    continue
                delta_type = delta.get("type")
                if delta_type == "thinking_delta":
                    thinking = delta.get("thinking")
                    if isinstance(thinking, str) and thinking:
                        yield {"type": "reasoning", "text": thinking}
                    continue
                if delta_type == "text_delta":
                    text = delta.get("text")
                    if isinstance(text, str) and text:
                        yield {"type": "text_delta", "text": text}
                    continue
                if delta_type == "input_json_delta":
                    index = self._stream_event_index(payload)
                    partial_json = delta.get("partial_json")
                    if isinstance(partial_json, str):
                        input_json_by_index[index] = (
                            input_json_by_index.get(index, "") + partial_json
                        )
                    continue
            if event_type == "content_block_stop":
                block = payload.get("content_block")
                if not isinstance(block, dict):
                    continue
                if block.get("type") != "tool_use":
                    continue
                index = self._stream_event_index(payload)
                raw_input = block.get("input")
                tool_input = raw_input if isinstance(raw_input, dict) else None
                if tool_input is None:
                    tool_input = self._load_stream_tool_input(
                        input_json_by_index.get(index, "")
                    )
                name = block.get("name")
                tool_id = block.get("id")
                if isinstance(name, str) and isinstance(tool_id, str):
                    yield {
                        "type": "tool_call",
                        "block": RuntimeBlock(
                            type="tool_call",
                            tool_name=name,
                            tool_arguments=tool_input,
                            call_id=tool_id,
                            provider_id=tool_id,
                            source="native",
                            metadata={"anthropic": dict(block)},
                        ),
                    }
                continue
            if event_type == "message_stop":
                message = payload.get("message")
                if isinstance(message, dict):
                    raw_id = message.get("id")
                    if isinstance(raw_id, str):
                        response_id = raw_id
                    raw_usage = message.get("usage")
                    if isinstance(raw_usage, dict):
                        usage = raw_usage
                continue
        yield {
            "type": "completed",
            "response_id": response_id,
            "metadata": {"usage": usage} if usage is not None else {},
        }

    def _iter_stream_payloads(self, stream: object) -> Iterator[object]:
        enter = getattr(stream, "__enter__", None)
        if callable(enter):
            with stream as active_stream:
                yield from active_stream
            return
        yield from cast(Any, stream)

    def _stream_event_index(self, payload: dict[str, object]) -> int:
        index = payload.get("index")
        return index if isinstance(index, int) else 0

    def _load_stream_tool_input(self, raw_json: str) -> dict[str, object]:
        if not raw_json.strip():
            return {}
        try:
            loaded = json.loads(raw_json)
        except json.JSONDecodeError:
            return {}
        return loaded if isinstance(loaded, dict) else {}

    def _thinking_payload(self) -> dict[str, object] | None:
        if not self._thinking_enabled:
            return {"type": "disabled"}
        effort = self._thinking_effort or "medium"
        budget = _THINKING_BUDGETS.get(effort, _THINKING_BUDGETS["medium"])
        if budget >= self._max_output_tokens:
            raise ModelResponseError(
                (
                    "Anthropic thinking budget must be lower than max_output_tokens "
                    f"(budget={budget}, max_output_tokens={self._max_output_tokens})."
                ),
                stop_reason=StopReason.MODEL_ERROR,
                failure_kind="invalid_provider_config",
            )
        return {"type": "enabled", "budget_tokens": budget}

    def _status_error(
        self,
        *,
        exc: APIStatusError,
        request_path: str | None,
    ) -> ModelResponseError:
        detail = _api_status_error_detail(exc)
        error_path = self._log_failure(
            message=detail,
            request_path=request_path,
            payload={
                "error_type": type(exc).__name__,
                "message": detail,
                "status_code": exc.status_code,
                "response_body": exc.body,
            },
        )
        return ModelResponseError(
            f"Anthropic provider returned HTTP {exc.status_code}: {detail}",
            error_path=error_path,
            log_path=self._default_error_log_path(),
            stop_reason=StopReason.MODEL_ERROR,
            is_retryable=exc.status_code >= 500 or exc.status_code == 429,
            failure_kind="provider_error",
        )

    def _log_request(self, payload_body: dict[str, object]) -> str | None:
        if self._log_service is None:
            return None
        context = self._log_context()
        path = self._log_service.write_raw_model_payload(
            kind="request",
            payload={
                "url": f"{self._base_url}/v1/messages",
                "method": "POST",
                "provider": "anthropic",
                "protocol": "anthropic_messages",
                "body": payload_body,
            },
            session_id=context.session_id,
            turn_id=context.turn_id,
        )
        relative_path = self._log_service.relative_path(path)
        self._log_service_event(
            level=LogLevel.INFO,
            event="model_request_started",
            message="Sent Anthropic Messages request",
            request_path=relative_path,
        )
        return relative_path

    def _log_response(self, payload: dict[str, object]) -> str | None:
        if self._log_service is None:
            return None
        context = self._log_context()
        path = self._log_service.write_raw_model_payload(
            kind="response",
            payload={
                "provider": "anthropic",
                "protocol": "anthropic_messages",
                "body": payload,
            },
            session_id=context.session_id,
            turn_id=context.turn_id,
        )
        return self._log_service.relative_path(path)

    def _log_failure(
        self,
        *,
        message: str,
        request_path: str | None,
        payload: dict[str, object],
    ) -> str | None:
        if self._log_service is None:
            return None
        context = self._log_context()
        path = self._log_service.write_error_payload(
            payload={
                "provider": "anthropic",
                "protocol": "anthropic_messages",
                **payload,
            },
            session_id=context.session_id,
            turn_id=context.turn_id,
        )
        relative_path = self._log_service.relative_path(path)
        self._log_service_event(
            level=LogLevel.ERROR,
            event="model_request_failed",
            message=message,
            request_path=request_path,
            error_path=relative_path,
        )
        return relative_path

    def _log_service_event(
        self,
        *,
        level: LogLevel,
        event: str,
        message: str,
        request_path: str | None = None,
        response_path: str | None = None,
        error_path: str | None = None,
    ) -> None:
        if self._log_service is None:
            return
        context = self._log_context()
        self._log_service.log_model_event(
            ModelLogEvent(
                timestamp=self._log_service.new_timestamp(),
                level=level,
                event=event,
                session_id=context.session_id,
                turn_id=context.turn_id,
                protocol="anthropic_messages",
                model=self._model,
                provider="anthropic",
                message=message,
                request_path=request_path,
                response_path=response_path,
                error_path=error_path,
            )
        )

    def _log_context(self) -> ModelLogContext:
        if self._log_context_provider is None:
            return ModelLogContext()
        return self._log_context_provider()

    def _default_error_log_path(self) -> str:
        if self._log_service is None:
            return "log/error.log"
        return self._log_service.error_log_display_path()


__all__ = [
    "AnthropicMessagesClient",
    "DEFAULT_ANTHROPIC_SDK_TIMEOUT_SECONDS",
    "_build_anthropic_sdk_client",
]
