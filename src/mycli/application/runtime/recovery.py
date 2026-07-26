from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from mycli.domain.runtime import StopReason
from mycli.llms.clients.openai_chat_errors import ModelResponseError


class RecoveryErrorClass(StrEnum):
    UNKNOWN = "unknown"
    INVALID_ENCRYPTED_CONTENT = "invalid_encrypted_content"
    CONTEXT_OVERFLOW = "context_overflow"
    SCHEMA_REJECTED = "schema_rejected"
    UNSUPPORTED_PAYLOAD = "unsupported_payload"
    IMAGE_TOO_LARGE = "image_too_large"


class RecoveryPolicyAction(StrEnum):
    SURFACE_ONLY = "surface_only"
    STRIP_ENCRYPTED_REASONING_RETRY = "strip_encrypted_reasoning_retry"
    COMPACT_OR_SHRINK_RETRY = "compact_or_shrink_retry"
    SANITIZE_REPAIR_RETRY = "sanitize_repair_retry"


@dataclass(slots=True, frozen=True)
class ErrorClassification:
    error_class: RecoveryErrorClass
    failure_kind: str
    stop_reason: str | None = None

    def to_trace_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "error_class": self.error_class.value,
            "failure_kind": self.failure_kind,
        }
        if self.stop_reason is not None:
            payload["stop_reason"] = self.stop_reason
        return payload


@dataclass(slots=True, frozen=True)
class RecoveryDecision:
    action: RecoveryPolicyAction
    should_retry: bool
    max_attempts: int = 0

    def to_trace_payload(self, *, attempt: int = 0) -> dict[str, object]:
        return {
            "action": self.action.value,
            "will_retry": self.should_retry,
            "attempt": attempt,
            "max_attempts": self.max_attempts,
        }


class ErrorClassifier:
    def classify(self, exc: ModelResponseError) -> ErrorClassification:
        failure_kind = (exc.failure_kind or "").strip()
        stop_reason = exc.stop_reason.value if exc.stop_reason is not None else None
        normalized = _normalize_error_text(" ".join((failure_kind, str(exc))))
        error_class = self._class_from_failure_kind(
            failure_kind=failure_kind,
            stop_reason=exc.stop_reason,
        )
        if error_class is RecoveryErrorClass.UNKNOWN:
            error_class = self._class_from_text(normalized)
        return ErrorClassification(
            error_class=error_class,
            failure_kind=failure_kind or error_class.value,
            stop_reason=stop_reason,
        )

    def _class_from_failure_kind(
        self,
        *,
        failure_kind: str,
        stop_reason: StopReason | None,
    ) -> RecoveryErrorClass:
        if stop_reason is StopReason.CONTEXT_WINDOW_EXCEEDED:
            return RecoveryErrorClass.CONTEXT_OVERFLOW
        if failure_kind in {
            "invalid_encrypted_content",
            "encrypted_reasoning_rejected",
        }:
            return RecoveryErrorClass.INVALID_ENCRYPTED_CONTENT
        if failure_kind in {"context_window_exceeded", "context_overflow"}:
            return RecoveryErrorClass.CONTEXT_OVERFLOW
        if failure_kind in {
            "schema_rejected",
            "invalid_request_schema",
            "invalid_tool_schema",
        }:
            return RecoveryErrorClass.SCHEMA_REJECTED
        if failure_kind in {
            "unsupported_payload",
            "unsupported_content",
            "unsupported_stream_event_type",
        }:
            return RecoveryErrorClass.UNSUPPORTED_PAYLOAD
        if failure_kind in {"image_too_large", "image_payload_too_large"}:
            return RecoveryErrorClass.IMAGE_TOO_LARGE
        return RecoveryErrorClass.UNKNOWN

    def _class_from_text(self, normalized: str) -> RecoveryErrorClass:
        if "encrypted_content" in normalized or "encrypted reasoning" in normalized:
            return RecoveryErrorClass.INVALID_ENCRYPTED_CONTENT
        if (
            "context length" in normalized
            or "context window" in normalized
            or "maximum context" in normalized
        ):
            return RecoveryErrorClass.CONTEXT_OVERFLOW
        if "schema" in normalized and any(
            term in normalized for term in ("invalid", "rejected", "unsupported")
        ):
            return RecoveryErrorClass.SCHEMA_REJECTED
        if "unsupported" in normalized and any(
            term in normalized for term in ("payload", "content", "block", "event")
        ):
            return RecoveryErrorClass.UNSUPPORTED_PAYLOAD
        if "image" in normalized and any(
            term in normalized for term in ("too large", "payload", "exceeds")
        ):
            return RecoveryErrorClass.IMAGE_TOO_LARGE
        return RecoveryErrorClass.UNKNOWN


class RecoveryPolicy:
    def decide(
        self,
        classification: ErrorClassification,
        *,
        deterministic_repair_available: bool = False,
    ) -> RecoveryDecision:
        if classification.error_class is RecoveryErrorClass.INVALID_ENCRYPTED_CONTENT:
            return RecoveryDecision(
                action=RecoveryPolicyAction.STRIP_ENCRYPTED_REASONING_RETRY,
                should_retry=True,
                max_attempts=1,
            )
        if classification.error_class is RecoveryErrorClass.CONTEXT_OVERFLOW:
            return RecoveryDecision(
                action=RecoveryPolicyAction.COMPACT_OR_SHRINK_RETRY,
                should_retry=True,
                max_attempts=2,
            )
        if classification.error_class is RecoveryErrorClass.SCHEMA_REJECTED:
            return RecoveryDecision(
                action=(
                    RecoveryPolicyAction.SANITIZE_REPAIR_RETRY
                    if deterministic_repair_available
                    else RecoveryPolicyAction.SURFACE_ONLY
                ),
                should_retry=deterministic_repair_available,
                max_attempts=1 if deterministic_repair_available else 0,
            )
        return RecoveryDecision(
            action=RecoveryPolicyAction.SURFACE_ONLY,
            should_retry=False,
            max_attempts=0,
        )


@dataclass(slots=True, frozen=True)
class RetryBackoffPolicy:
    base_seconds: float = 0.2
    multiplier: float = 2.0
    max_seconds: float = 4.0
    jitter_ratio: float = 0.1

    def delay_for_attempt(
        self,
        attempt: int,
        *,
        jitter_factor: float = 1.0,
        retry_after_seconds: float | None = None,
    ) -> float:
        if retry_after_seconds is not None:
            return max(0.0, retry_after_seconds)
        if attempt <= 0:
            return 0.0
        delay = self.base_seconds * (self.multiplier ** (attempt - 1))
        bounded_factor = min(
            1.0 + self.jitter_ratio,
            max(1.0 - self.jitter_ratio, jitter_factor),
        )
        return min(self.max_seconds, delay) * bounded_factor


TRANSIENT_FAILURE_KINDS = frozenset(
    {
        "request_timeout",
        "rate_limited",
        "provider_overloaded",
        "provider_unavailable",
        "transport_error",
        "http_error",
    }
)


def is_transient_recovery_failure(*, failure_kind: str, is_retryable: bool) -> bool:
    return is_retryable or failure_kind in TRANSIENT_FAILURE_KINDS


def retry_metadata(
    *,
    attempt: int,
    max_attempts: int,
    delay_seconds: float,
    failure_kind: str,
) -> dict[str, object]:
    return {
        "recovery_kind": "retry",
        "attempt": attempt,
        "max_attempts": max_attempts,
        "delay_seconds": delay_seconds,
        "failure_kind": failure_kind,
    }


def fallback_metadata(
    *,
    from_model: str,
    to_model: str,
    failure_kind: str,
) -> dict[str, object]:
    return {
        "recovery_kind": "fallback_model",
        "from_model": from_model,
        "to_model": to_model,
        "failure_kind": failure_kind,
    }


def recovery_diagnostic_metadata(
    *,
    classification: ErrorClassification,
    decision: RecoveryDecision,
    attempt: int = 0,
) -> dict[str, object]:
    return {
        **classification.to_trace_payload(),
        **decision.to_trace_payload(attempt=attempt),
    }


def _normalize_error_text(value: str) -> str:
    return " ".join(value.lower().replace("-", "_").split())
