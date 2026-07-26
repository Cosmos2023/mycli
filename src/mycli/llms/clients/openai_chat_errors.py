from __future__ import annotations

from datetime import UTC, datetime
from email.utils import parsedate_to_datetime

from mycli.domain.runtime import StopReason


class ModelResponseError(RuntimeError):
    """Raised when the model provider returns an invalid or non-decodable response."""

    def __init__(
        self,
        message: str,
        *,
        error_path: str | None = None,
        log_path: str | None = None,
        stop_reason: StopReason | None = None,
        is_retryable: bool = False,
        failure_kind: str | None = None,
        retry_after_seconds: float | None = None,
    ) -> None:
        super().__init__(message)
        self.error_path = error_path
        self.log_path = log_path
        self.stop_reason = stop_reason
        self.is_retryable = is_retryable
        self.failure_kind = failure_kind
        self.retry_after_seconds = retry_after_seconds
        self.stream_started = False
        self.partial_output = False


def retry_after_seconds_from_status_error(exc: object) -> float | None:
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if headers is None:
        return None
    retry_after_ms = headers.get("retry-after-ms")
    if retry_after_ms is not None:
        try:
            return max(0.0, float(retry_after_ms) / 1000.0)
        except (TypeError, ValueError):
            pass
    retry_after = headers.get("retry-after")
    if retry_after is None:
        return None
    try:
        return max(0.0, float(retry_after))
    except (TypeError, ValueError):
        pass
    try:
        retry_at = parsedate_to_datetime(str(retry_after))
    except (TypeError, ValueError, OverflowError):
        return None
    if retry_at.tzinfo is None:
        retry_at = retry_at.replace(tzinfo=UTC)
    return max(0.0, (retry_at - datetime.now(tz=UTC)).total_seconds())
