from __future__ import annotations

import json
from json import JSONDecodeError
from pathlib import Path
from typing import Any

from mycli.domain.runtime.tracing import RuntimeTraceEvent
from mycli.infrastructure.filesystem import ensure_parent
from mycli.services.storage_layout import MycliStorageLayout


_TRACE_PREVIEW_CHARS = 240


class TraceService:
    def __init__(self, home_dir: Path) -> None:
        self._layout = MycliStorageLayout.from_home_dir(home_dir)

    def append(self, session_id: str, event: RuntimeTraceEvent) -> None:
        self._validate_session_id(session_id)
        path = self._trace_path(session_id)
        ensure_parent(path)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(self._sanitize_event(event), ensure_ascii=False))
            handle.write("\n")

    def load(self, session_id: str) -> tuple[RuntimeTraceEvent, ...]:
        self._validate_session_id(session_id)
        path = self._read_trace_path(session_id)
        if not path.exists():
            return ()
        events: list[RuntimeTraceEvent] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                payload = json.loads(line)
            except JSONDecodeError:
                continue
            if not isinstance(payload, dict):
                continue
            try:
                events.append(RuntimeTraceEvent.from_dict(payload))
            except (KeyError, TypeError, ValueError):
                continue
        return tuple(events)

    def load_for_turn(self, session_id: str, turn_id: str) -> tuple[RuntimeTraceEvent, ...]:
        return tuple(
            event for event in self.load(session_id) if event.turn_id == turn_id
        )

    def _trace_path(self, session_id: str) -> Path:
        return self._layout.trace_path(session_id)

    def _read_trace_path(self, session_id: str) -> Path:
        path = self._trace_path(session_id)
        if path.exists():
            return path
        return self._layout.legacy_trace_path(session_id)

    @staticmethod
    def _validate_session_id(session_id: str) -> None:
        if (
            not session_id
            or session_id.startswith("<")
            or session_id.endswith(">")
            or "/" in session_id
            or "\\" in session_id
            or ".." in session_id
        ):
            raise ValueError(f"invalid trace session id: {session_id!r}")

    @classmethod
    def _sanitize_event(cls, event: RuntimeTraceEvent) -> dict[str, Any]:
        return {
            "kind": event.kind,
            "turn_id": event.turn_id,
            "payload": cls._sanitize_value(event.payload),
        }

    @classmethod
    def _sanitize_value(cls, value: Any) -> Any:
        if isinstance(value, dict):
            return cls._sanitize_mapping(value)
        if isinstance(value, (list, tuple)):
            return [cls._sanitize_value(item) for item in value]
        return value

    @classmethod
    def _sanitize_mapping(cls, value: dict[Any, Any]) -> dict[str, Any]:
        sanitized: dict[str, Any] = {}
        for raw_key, raw_value in value.items():
            key = str(raw_key)
            if key == "raw_payload" and isinstance(raw_value, dict):
                sanitized[key] = cls._sanitize_raw_payload(raw_value)
                continue
            if key == "transcript_content" and isinstance(raw_value, str):
                sanitized["transcript_content_chars"] = len(raw_value)
                sanitized["transcript_content_preview"] = cls._preview(raw_value)
                continue
            if key == "instruction_contract" and isinstance(raw_value, dict):
                sanitized[key] = {"redacted": True}
                continue
            if key == "current_user_request" and isinstance(raw_value, str):
                sanitized["current_user_request_chars"] = len(raw_value)
                sanitized["current_user_request_preview"] = cls._preview(raw_value)
                continue
            sanitized[key] = cls._sanitize_value(raw_value)
        return sanitized

    @classmethod
    def _sanitize_raw_payload(cls, value: dict[Any, Any]) -> dict[str, Any]:
        sanitized: dict[str, Any] = {}
        for raw_key, raw_value in value.items():
            key = str(raw_key)
            if key == "content" and isinstance(raw_value, str):
                sanitized["content_chars"] = len(raw_value)
                sanitized["content_preview"] = cls._preview(raw_value)
                continue
            sanitized[key] = cls._sanitize_value(raw_value)
        return sanitized

    @staticmethod
    def _preview(value: str) -> str:
        if len(value) <= _TRACE_PREVIEW_CHARS:
            return value
        return value[:_TRACE_PREVIEW_CHARS] + "..."
