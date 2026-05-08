from __future__ import annotations

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
    ) -> None:
        super().__init__(message)
        self.error_path = error_path
        self.log_path = log_path
        self.stop_reason = stop_reason
        self.is_retryable = is_retryable
        self.failure_kind = failure_kind
