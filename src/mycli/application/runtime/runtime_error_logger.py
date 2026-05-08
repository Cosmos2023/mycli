from __future__ import annotations

import traceback

from mycli.domain.logging import LogLevel
from mycli.domain.runtime import AgentConfig
from mycli.utils.workspace_logger import WorkspaceLogService


class RuntimeErrorLogger:
    def __init__(
        self,
        *,
        config: AgentConfig,
        workspace_log_service: WorkspaceLogService,
    ) -> None:
        self._config = config
        self._workspace_log_service = workspace_log_service

    def set_config(self, config: AgentConfig) -> None:
        self._config = config

    def details(self, error_path: str | None) -> tuple[str, ...]:
        details = [f"Details logged to {self._workspace_log_service.error_log_display_path()}"]
        if error_path:
            details.append(f"Raw error saved to {error_path}")
        return tuple(details)

    def log_exception(
        self,
        *,
        turn_id: str,
        phase: str,
        exc: Exception,
    ) -> str:
        payload = {
            "error_type": type(exc).__name__,
            "message": str(exc),
            "traceback": traceback.format_exc(),
            "phase": phase,
            "session_id": self._config.session_id,
            "turn_id": turn_id,
            "model": self._config.model,
            "protocol": self._config.protocol,
        }
        path = self._workspace_log_service.write_error_payload(
            payload=payload,
            session_id=self._config.session_id,
            turn_id=turn_id,
        )
        relative_path = self._workspace_log_service.relative_path(path)
        self._workspace_log_service.log(
            level=LogLevel.ERROR,
            event=phase,
            message=str(exc),
            context={
                "session_id": self._config.session_id,
                "turn_id": turn_id,
                "error_path": relative_path,
            },
        )
        return relative_path
