from __future__ import annotations

from collections.abc import Callable
from urllib.parse import urlparse

from mycli.domain.logging import LogLevel, ModelLogContext, ModelLogEvent
from mycli.utils.workspace_logger import WorkspaceLogService


class ResponsesClientLogger:
    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        log_service: WorkspaceLogService | None,
        log_context_provider: Callable[[], ModelLogContext] | None = None,
    ) -> None:
        self._base_url = base_url
        self._model = model
        self._log_service = log_service
        self._log_context_provider = log_context_provider

    def set_log_context_provider(
        self,
        provider: Callable[[], ModelLogContext],
    ) -> None:
        self._log_context_provider = provider

    def set_model(self, model: str) -> None:
        self._model = model

    def provider_name(self) -> str:
        parsed = urlparse(self._base_url)
        return parsed.netloc or self._base_url

    def default_error_log_path(self) -> str:
        if self._log_service is None:
            return "log/error.log"
        return self._log_service.error_log_display_path()

    def log_request(
        self,
        *,
        url: str,
        payload_body: dict[str, object],
        continuation_decision: str,
        previous_response_id: str | None,
    ) -> str | None:
        if self._log_service is None:
            return None
        context = self.log_context()
        path = self._log_service.write_raw_model_payload(
            kind="request",
            payload={
                "url": url,
                "method": "POST",
                "body": payload_body,
                "continuation": {
                    "decision": continuation_decision,
                    "previous_response_id": previous_response_id,
                },
            },
            session_id=context.session_id,
            turn_id=context.turn_id,
        )
        relative_path = self._log_service.relative_path(path)
        self.log_service_event(
            level=LogLevel.INFO,
            event="model_request_started",
            message="Sent model request",
            request_path=relative_path,
        )
        return relative_path

    def log_response(self, payload: dict[str, object]) -> str | None:
        if self._log_service is None:
            return None
        context = self.log_context()
        path = self._log_service.write_raw_model_payload(
            kind="response",
            payload=payload,
            session_id=context.session_id,
            turn_id=context.turn_id,
        )
        return self._log_service.relative_path(path)

    def log_failure(
        self,
        *,
        error_type: str,
        message: str,
        request_path: str | None,
        payload: dict[str, object],
    ) -> str | None:
        del error_type
        if self._log_service is None:
            return None
        context = self.log_context()
        path = self._log_service.write_error_payload(
            payload=payload,
            session_id=context.session_id,
            turn_id=context.turn_id,
        )
        relative_path = self._log_service.relative_path(path)
        self.log_service_event(
            level=LogLevel.ERROR,
            event="model_request_failed",
            message=message,
            request_path=request_path,
            error_path=relative_path,
        )
        return relative_path

    def log_service_event(
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
        context = self.log_context()
        self._log_service.log_model_event(
            ModelLogEvent(
                timestamp=self._log_service.new_timestamp(),
                level=level,
                event=event,
                session_id=context.session_id,
                turn_id=context.turn_id,
                protocol="responses",
                model=self._model,
                provider=self.provider_name(),
                message=message,
                request_path=request_path,
                response_path=response_path,
                error_path=error_path,
            )
        )

    def log_context(self) -> ModelLogContext:
        if self._log_context_provider is None:
            return ModelLogContext()
        return self._log_context_provider()
