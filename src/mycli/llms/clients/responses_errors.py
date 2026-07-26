from __future__ import annotations

import re
from dataclasses import dataclass

from openai import APIConnectionError, APIStatusError, APITimeoutError

from mycli.domain.logging import LogLevel
from mycli.domain.runtime import StopReason
from mycli.llms.clients.openai_chat import ModelResponseError, _api_status_error_detail
from mycli.llms.clients.openai_chat_errors import retry_after_seconds_from_status_error
from mycli.llms.clients.responses_logging import ResponsesClientLogger


@dataclass(slots=True, frozen=True)
class FailureClassification:
    stop_reason: StopReason
    is_retryable: bool
    failure_kind: str


def classify_provider_failure(
    *,
    detail: str,
    status_code: int | None,
    provider_error_code: str | None,
) -> FailureClassification:
    normalized_detail = detail.lower()
    normalized_code = provider_error_code.lower() if isinstance(provider_error_code, str) else ""
    context_markers = (
        "context length",
        "maximum context length",
        "context window",
        "too many tokens",
        "input too long",
    )
    if normalized_code in {"context_length_exceeded", "context_window_exceeded"} or any(
        marker in normalized_detail for marker in context_markers
    ):
        return FailureClassification(
            stop_reason=StopReason.CONTEXT_WINDOW_EXCEEDED,
            is_retryable=False,
            failure_kind="context_window_exceeded",
        )
    output_markers = (
        "max output tokens",
        "output token",
        "completion token",
        "response too long",
    )
    if normalized_code in {
        "output_token_limit",
        "max_output_tokens",
        "output_tokens_exceeded",
    } or any(marker in normalized_detail for marker in output_markers):
        return FailureClassification(
            stop_reason=StopReason.MODEL_ERROR,
            is_retryable=True,
            failure_kind="output_token_limit",
        )
    auth_markers = ("api key", "authentication", "authorization", "unauthorized", "forbidden")
    if status_code in {401, 403} or any(marker in normalized_detail for marker in auth_markers):
        return FailureClassification(
            stop_reason=StopReason.AUTH_FAILED,
            is_retryable=False,
            failure_kind="auth_error",
        )
    if status_code == 408:
        return FailureClassification(
            stop_reason=StopReason.TRANSPORT_FAILED,
            is_retryable=True,
            failure_kind="request_timeout",
        )
    if status_code == 429 or normalized_code in {"rate_limit_exceeded", "rate_limited"}:
        return FailureClassification(
            stop_reason=StopReason.RATE_LIMITED,
            is_retryable=True,
            failure_kind="rate_limited",
        )
    if status_code == 529:
        return FailureClassification(
            stop_reason=StopReason.RATE_LIMITED,
            is_retryable=True,
            failure_kind="provider_overloaded",
        )
    if status_code in {500, 502, 503, 504}:
        return FailureClassification(
            stop_reason=StopReason.TRANSPORT_FAILED,
            is_retryable=True,
            failure_kind="provider_unavailable",
        )
    return FailureClassification(
        stop_reason=StopReason.MODEL_ERROR,
        is_retryable=False,
        failure_kind="provider_error",
    )


_RETRY_AFTER_PATTERN = re.compile(
    r"(?:try again|retry)\s+in\s+([0-9]+(?:\.[0-9]+)?)\s*(ms|s|seconds?)\b",
    re.IGNORECASE,
)


def _retry_after_seconds_from_text(detail: str) -> float | None:
    match = _RETRY_AFTER_PATTERN.search(detail)
    if match is None:
        return None
    value = float(match.group(1))
    unit = match.group(2).lower()
    return value / 1000.0 if unit == "ms" else value


class ResponsesErrorFactory:
    def __init__(self, *, logger: ResponsesClientLogger) -> None:
        self._logger = logger

    def api_status_error_detail(self, exc: APIStatusError) -> str:
        cached = getattr(exc, "_mycli_cached_detail", None)
        if isinstance(cached, str):
            return cached
        detail = _api_status_error_detail(exc)
        setattr(exc, "_mycli_cached_detail", detail)
        return detail

    def continuation_retry_reason(
        self,
        *,
        exc: APIStatusError,
        used_previous_response_id: str | None,
    ) -> str | None:
        if not used_previous_response_id:
            return None
        if exc.status_code in {500, 502, 503, 504}:
            return "provider_failed_previous_response_id_continuation"
        if exc.status_code not in {400, 404, 409}:
            return None
        detail = self.api_status_error_detail(exc).lower()
        if "previous_response_id" in detail:
            return "provider_rejected_previous_response_id"
        if "response_id" in detail and any(
            marker in detail for marker in ("not found", "invalid", "expired")
        ):
            return "provider_rejected_previous_response_id"
        if "response id" in detail and any(
            marker in detail for marker in ("not found", "invalid", "expired")
        ):
            return "provider_rejected_previous_response_id"
        return None

    def build_response_failed_error(
        self,
        *,
        event: dict[str, object],
        request_path: str | None,
    ) -> ModelResponseError:
        response = event.get("response", {})
        error_payload = response.get("error", {}) if isinstance(response, dict) else {}
        detail = "Model provider returned response.failed."
        error_code: str | None = None
        if isinstance(error_payload, dict):
            raw_message = error_payload.get("message")
            if isinstance(raw_message, str) and raw_message.strip():
                detail = raw_message
            raw_code = error_payload.get("code")
            if isinstance(raw_code, str) and raw_code.strip():
                error_code = raw_code
        classification = self.classify_provider_failure(
            detail=detail,
            status_code=None,
            provider_error_code=error_code,
        )
        error_path = self._logger.log_failure(
            error_type="ModelResponseError",
            message=detail,
            request_path=request_path,
            payload={
                "error_type": "ModelResponseError",
                "message": detail,
                "failure_kind": classification.failure_kind,
                "response": response if isinstance(response, dict) else {},
            },
        )
        self._logger.log_service_event(
            level=LogLevel.ERROR,
            event="model_stream_failed",
            message=detail,
            request_path=request_path,
            error_path=error_path,
        )
        return ModelResponseError(
            detail,
            error_path=error_path,
            log_path=self._logger.default_error_log_path(),
            stop_reason=classification.stop_reason,
            is_retryable=classification.is_retryable,
            failure_kind=classification.failure_kind,
            retry_after_seconds=_retry_after_seconds_from_text(detail),
        )

    def build_http_error(
        self,
        *,
        exc: APIStatusError,
        request_path: str | None,
    ) -> ModelResponseError:
        detail = self.api_status_error_detail(exc)
        error_body = exc.body
        if self.is_unsupported_responses_provider_error(
            status_code=exc.status_code,
            detail=detail,
        ):
            error_path = self._logger.log_failure(
                error_type=type(exc).__name__,
                message=detail,
                request_path=request_path,
                payload={
                    "error_type": type(exc).__name__,
                    "message": detail,
                    "status_code": exc.status_code,
                    "response_body": error_body,
                },
            )
            return ModelResponseError(
                "Responses API is not available for the current provider. "
                "Use protocol='chat_completions' for providers that do not support the Responses API.",
                error_path=error_path,
                log_path=self._logger.default_error_log_path(),
                stop_reason=StopReason.MODEL_ERROR,
                is_retryable=False,
                failure_kind="unsupported_responses_provider",
            )
        provider_name = self._logger.provider_name()
        classification = self.classify_provider_failure(
            detail=detail,
            status_code=exc.status_code,
            provider_error_code=None,
        )
        error_path = self._logger.log_failure(
            error_type=type(exc).__name__,
            message=detail,
            request_path=request_path,
            payload={
                "error_type": type(exc).__name__,
                "message": detail,
                "status_code": exc.status_code,
                "response_body": error_body,
                "failure_kind": classification.failure_kind,
            },
        )
        return ModelResponseError(
            f"Model provider '{provider_name}' returned HTTP {exc.status_code}: {detail}",
            error_path=error_path,
            log_path=self._logger.default_error_log_path(),
            stop_reason=classification.stop_reason,
            is_retryable=classification.is_retryable,
            failure_kind=classification.failure_kind,
            retry_after_seconds=retry_after_seconds_from_status_error(exc),
        )

    def build_transport_error(
        self,
        *,
        exc: APIConnectionError | APITimeoutError,
        request_path: str | None,
    ) -> ModelResponseError:
        reason = str(exc)
        error_path = self._logger.log_failure(
            error_type=type(exc).__name__,
            message=str(reason),
            request_path=request_path,
            payload={
                "error_type": type(exc).__name__,
                "message": str(reason),
                "failure_kind": "transport_error",
            },
        )
        return ModelResponseError(
            f"Failed to reach model provider: {reason}",
            error_path=error_path,
            log_path=self._logger.default_error_log_path(),
            stop_reason=StopReason.TRANSPORT_FAILED,
            is_retryable=True,
            failure_kind="transport_error",
        )

    def build_retry_exhausted_error(
        self,
        *,
        cause: ModelResponseError,
        request_path: str | None,
        attempts: int,
    ) -> ModelResponseError:
        detail = f"Model stream retry budget exhausted after {attempts} attempt(s): {cause}"
        error_path = self._logger.log_failure(
            error_type="ModelResponseError",
            message=detail,
            request_path=request_path,
            payload={
                "error_type": "ModelResponseError",
                "message": detail,
                "failure_kind": "retry_exhausted",
                "attempts": attempts,
                "cause": cause.failure_kind,
            },
        )
        self._logger.log_service_event(
            level=LogLevel.ERROR,
            event="model_stream_retry_exhausted",
            message=detail,
            request_path=request_path,
            error_path=error_path,
        )
        return ModelResponseError(
            detail,
            error_path=error_path,
            log_path=self._logger.default_error_log_path(),
            stop_reason=StopReason.RETRY_EXHAUSTED,
            is_retryable=False,
            failure_kind="retry_exhausted",
        )

    def is_unsupported_responses_provider_error(
        self,
        *,
        status_code: int,
        detail: str,
    ) -> bool:
        normalized_detail = detail.lower()
        has_responses_hint = "/responses" in normalized_detail or "responses api" in normalized_detail
        has_unsupported_hint = any(
            marker in normalized_detail
            for marker in ("not found", "unsupported", "not available", "does not support")
        )
        if has_responses_hint and has_unsupported_hint:
            return True
        return status_code in (404, 405) and has_responses_hint

    def classify_provider_failure(
        self,
        *,
        detail: str,
        status_code: int | None,
        provider_error_code: str | None,
    ) -> FailureClassification:
        return classify_provider_failure(
            detail=detail,
            status_code=status_code,
            provider_error_code=provider_error_code,
        )
