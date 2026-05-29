from __future__ import annotations

import json
import re
from collections.abc import Callable
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from mycli.domain.logging import LogLevel, ModelLogEvent
from mycli.infrastructure.filesystem import ensure_parent, write_json

_SECRET_VALUE = "[REDACTED]"
_SENSITIVE_KEYS = frozenset(
    {
        "authorization",
        "api_key",
        "apikey",
        "x-api-key",
        "token",
        "access_token",
        "refresh_token",
        "secret",
        "password",
    }
)
_BEARER_PATTERN = re.compile(r"(?i)\b(Bearer\s+)([A-Za-z0-9_./+=:-]{6,})\b")
_ASSIGNMENT_PATTERN = re.compile(
    r"(?i)\b([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_.-]*)(\s*[:=]\s*)([\"']?)([^\"'\s,;}]+)(\3)"
)
_OPENAI_KEY_PATTERN = re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{6,}\b")


class WorkspaceLogService:
    def __init__(
        self,
        workspace_root: Path,
        logs_root: Path | None = None,
        session_id: str | None = None,
        now_provider: Callable[[], datetime] | None = None,
    ) -> None:
        self._workspace_root = workspace_root
        self._logs_root = logs_root or (workspace_root / "log")
        self._raw_root = self._logs_root / "model-raw"
        self._session_id = session_id
        self._now_provider = now_provider or (lambda: datetime.now(timezone.utc))

    def set_session_id(self, session_id: str | None) -> None:
        self._session_id = session_id

    def log(
        self,
        *,
        level: LogLevel,
        event: str,
        message: str,
        context: dict[str, Any] | None = None,
    ) -> None:
        timestamp = self._timestamp_iso()
        session_tag = f" [{self._session_id}]" if self._session_id else ""
        line = f"{timestamp} {level.name}{session_tag} {event} {self._redact_text(message)}"
        if context:
            safe_context = self._redact_payload(context)
            line += " " + json.dumps(safe_context, ensure_ascii=False, sort_keys=True)
        line = self._redact_text(line)
        self._append_line(self.agent_log_path(), line)
        if level in {LogLevel.WARNING, LogLevel.ERROR}:
            self._append_line(self.error_log_path(), line)

    def log_model_event(self, event: ModelLogEvent) -> None:
        path = self._logs_root / "model-events.jsonl"
        ensure_parent(path)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(self._redact_payload(event.to_dict()), ensure_ascii=False))
            handle.write("\n")
        self.log(
            level=event.level,
            event=event.event,
            message=event.message,
            context={
                "session_id": event.session_id,
                "turn_id": event.turn_id,
                "protocol": event.protocol,
                "model": event.model,
                "provider": event.provider,
                "request_path": event.request_path,
                "response_path": event.response_path,
                "error_path": event.error_path,
            },
        )

    def write_raw_model_payload(
        self,
        *,
        kind: str,
        payload: Any,
        session_id: str,
        turn_id: str,
    ) -> Path:
        raw_session_id = session_id or self._session_id or "default"
        safe_session_id = self._safe_path_part(raw_session_id)
        path = self._raw_root / safe_session_id / self._build_raw_file_name(
            kind=kind,
            session_id=raw_session_id,
            turn_id=turn_id,
        )
        write_json(path, self._redact_payload(payload))
        return path

    def write_error_payload(
        self,
        *,
        payload: Any,
        session_id: str,
        turn_id: str,
    ) -> Path:
        return self.write_raw_model_payload(
            kind="error",
            payload=payload,
            session_id=session_id,
            turn_id=turn_id,
        )

    def new_timestamp(self) -> str:
        return self._timestamp_iso()

    def relative_path(self, path: Path) -> str:
        try:
            return str(path.relative_to(self._workspace_root))
        except ValueError:
            pass
        return str(path)

    def agent_log_path(self) -> Path:
        return self._logs_root / "agent.log"

    def error_log_path(self) -> Path:
        return self._logs_root / "errors.log"

    def error_log_display_path(self) -> str:
        return self.relative_path(self.error_log_path())

    def model_events_path(self) -> Path:
        return self._logs_root / "model-events.jsonl"

    def model_raw_dir(self) -> Path:
        return self._raw_root / self._safe_path_part(self._session_id or "default")

    def inspect_logs(self, *, tail: int = 20) -> tuple[str, ...]:
        lines = [
            f"agent_log={self.agent_log_path()}",
            f"errors_log={self.error_log_path()}",
            f"model_events={self.model_events_path()}",
            f"model_raw={self.model_raw_dir()}",
        ]
        for line in self._tail_lines(self.agent_log_path(), tail):
            lines.append(f"tail: {line}")
        return tuple(lines)

    def _append_line(self, path: Path, line: str) -> None:
        ensure_parent(path)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line)
            handle.write("\n")

    def _build_raw_file_name(self, *, kind: str, session_id: str, turn_id: str) -> str:
        safe_session_id = self._safe_path_part(session_id)
        safe_turn_id = self._safe_path_part(turn_id)
        safe_kind = self._safe_path_part(kind)
        return f"{self._timestamp_compact()}-{safe_session_id}-{safe_turn_id}-{safe_kind}.json"

    def _timestamp_iso(self) -> str:
        return self._normalize_timestamp(self._now_provider()).isoformat().replace("+00:00", "Z")

    def _timestamp_compact(self) -> str:
        return self._normalize_timestamp(self._now_provider()).strftime("%Y%m%dT%H%M%S%fZ")

    def _normalize_timestamp(self, value: datetime) -> datetime:
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    def _tail_lines(self, path: Path, limit: int) -> tuple[str, ...]:
        if limit <= 0 or not path.exists():
            return ()
        with path.open("r", encoding="utf-8") as handle:
            return tuple(deque((line.rstrip("\n") for line in handle), maxlen=limit))

    def _safe_path_part(self, value: str) -> str:
        return re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("-") or "default"

    def _redact_payload(self, payload: Any, *, key: str | None = None) -> Any:
        if isinstance(payload, dict):
            return {
                str(item_key): self._redact_payload(item_value, key=str(item_key))
                for item_key, item_value in payload.items()
            }
        if isinstance(payload, list):
            return [self._redact_payload(item, key=key) for item in payload]
        if isinstance(payload, tuple):
            return [self._redact_payload(item, key=key) for item in payload]
        if isinstance(payload, str):
            if key is not None and self._is_sensitive_key(key):
                if key.lower() == "authorization" and payload.lower().startswith("bearer "):
                    return "Bearer " + _SECRET_VALUE
                return _SECRET_VALUE
            return self._redact_text(payload)
        return payload

    def _redact_text(self, value: str) -> str:
        redacted = _BEARER_PATTERN.sub(rf"\1{_SECRET_VALUE}", value)
        redacted = _ASSIGNMENT_PATTERN.sub(rf"\1\2\3{_SECRET_VALUE}\5", redacted)
        return _OPENAI_KEY_PATTERN.sub(_SECRET_VALUE, redacted)

    def _is_sensitive_key(self, key: str) -> bool:
        normalized = key.strip().lower().replace("-", "_")
        if normalized in _SENSITIVE_KEYS:
            return True
        return any(part in normalized for part in ("api_key", "apikey", "token", "secret", "password"))
