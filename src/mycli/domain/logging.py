from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class LogLevel(StrEnum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"


@dataclass(slots=True, frozen=True)
class ModelLogEvent:
    timestamp: str
    level: LogLevel
    event: str
    session_id: str
    turn_id: str
    protocol: str
    model: str
    provider: str
    message: str
    request_path: str | None = None
    response_path: str | None = None
    error_path: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "timestamp": self.timestamp,
            "level": self.level.value,
            "event": self.event,
            "session_id": self.session_id,
            "turn_id": self.turn_id,
            "protocol": self.protocol,
            "model": self.model,
            "provider": self.provider,
            "message": self.message,
        }
        if self.request_path is not None:
            payload["request_path"] = self.request_path
        if self.response_path is not None:
            payload["response_path"] = self.response_path
        if self.error_path is not None:
            payload["error_path"] = self.error_path
        return payload


@dataclass(slots=True, frozen=True)
class ModelLogContext:
    session_id: str = "unknown"
    turn_id: str = "unknown"
