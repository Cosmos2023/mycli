from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True, frozen=True)
class RetryBackoffPolicy:
    base_seconds: float = 0.25
    multiplier: float = 2.0
    max_seconds: float = 4.0

    def delay_for_attempt(self, attempt: int) -> float:
        if attempt <= 0:
            return 0.0
        delay = self.base_seconds * (self.multiplier ** (attempt - 1))
        return min(self.max_seconds, delay)


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


def output_limit_metadata(
    *,
    attempt: int,
    max_attempts: int,
    failure_kind: str,
    original_max_output_tokens: int | None = None,
    escalated_max_output_tokens: int | None = None,
) -> dict[str, object]:
    metadata: dict[str, object] = {
        "recovery_kind": "output_token_recovery",
        "attempt": attempt,
        "max_attempts": max_attempts,
        "failure_kind": failure_kind,
    }
    if original_max_output_tokens is not None:
        metadata["original_max_output_tokens"] = original_max_output_tokens
    if escalated_max_output_tokens is not None:
        metadata["escalated_max_output_tokens"] = escalated_max_output_tokens
    return metadata
