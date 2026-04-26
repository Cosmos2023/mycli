from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any, cast

from anthropic import (
    APIConnectionError,
    APIResponseValidationError,
    APIStatusError,
    APITimeoutError,
    Anthropic,
)

from mycli.domain.logging import LogLevel, ModelLogContext, ModelLogEvent
from mycli.domain.runtime import StopReason
from mycli.infrastructure.openai_client import ModelResponseError
from mycli.infrastructure.ssl import ensure_certifi_ca_bundle
from mycli.services.workspace_log_service import WorkspaceLogService

DEFAULT_ANTHROPIC_SDK_TIMEOUT_SECONDS = 60.0

_THINKING_BUDGETS: dict[str, int] = {
    "low": 1024,
    "medium": 1536,
    "high": 4096,
    "xhigh": 8192,
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

    def create_message(
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

    def _thinking_payload(self) -> dict[str, object] | None:
        if not self._thinking_enabled:
            return None
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
