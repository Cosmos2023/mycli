from __future__ import annotations

import json
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from mycli.domain.logging import LogLevel, ModelLogEvent
from mycli.infrastructure.filesystem import ensure_parent, write_json


class WorkspaceLogService:
    def __init__(
        self,
        workspace_root: Path,
        logs_root: Path | None = None,
        now_provider: Callable[[], datetime] | None = None,
    ) -> None:
        self._workspace_root = workspace_root
        self._logs_root = logs_root or (workspace_root / "log")
        self._raw_root = self._logs_root / "model-raw"
        self._now_provider = now_provider or (lambda: datetime.now(timezone.utc))

    def log(
        self,
        *,
        level: LogLevel,
        event: str,
        message: str,
        context: dict[str, Any] | None = None,
    ) -> None:
        timestamp = self._timestamp_iso()
        line = f"{timestamp} {level.name} {event} {message}"
        if context:
            line += " " + json.dumps(context, ensure_ascii=False, sort_keys=True)
        self._append_line(self._logs_root / "app.log", line)
        if level is LogLevel.ERROR:
            self._append_line(self._logs_root / "error.log", line)

    def log_model_event(self, event: ModelLogEvent) -> None:
        path = self._logs_root / "model-events.jsonl"
        ensure_parent(path)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event.to_dict(), ensure_ascii=False))
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
        path = self._raw_root / self._build_raw_file_name(
            kind=kind,
            session_id=session_id,
            turn_id=turn_id,
        )
        write_json(path, payload)
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

    def error_log_path(self) -> Path:
        return self._logs_root / "error.log"

    def error_log_display_path(self) -> str:
        return self.relative_path(self.error_log_path())

    def _append_line(self, path: Path, line: str) -> None:
        ensure_parent(path)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line)
            handle.write("\n")

    def _build_raw_file_name(self, *, kind: str, session_id: str, turn_id: str) -> str:
        return f"{self._timestamp_compact()}-{session_id}-{turn_id}-{kind}.json"

    def _timestamp_iso(self) -> str:
        return self._normalize_timestamp(self._now_provider()).isoformat().replace("+00:00", "Z")

    def _timestamp_compact(self) -> str:
        return self._normalize_timestamp(self._now_provider()).strftime("%Y%m%dT%H%M%S%fZ")

    def _normalize_timestamp(self, value: datetime) -> datetime:
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
