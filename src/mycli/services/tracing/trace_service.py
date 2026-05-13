from __future__ import annotations

import json
from json import JSONDecodeError
from pathlib import Path

from mycli.domain.runtime.tracing import RuntimeTraceEvent
from mycli.infrastructure.filesystem import ensure_parent


class TraceService:
    def __init__(self, home_dir: Path) -> None:
        self._sessions_root = home_dir / ".mycli" / "sessions"

    def append(self, session_id: str, event: RuntimeTraceEvent) -> None:
        path = self._trace_path(session_id)
        ensure_parent(path)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event.to_dict(), ensure_ascii=False))
            handle.write("\n")

    def load(self, session_id: str) -> tuple[RuntimeTraceEvent, ...]:
        path = self._trace_path(session_id)
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
        return self._sessions_root / f"{session_id}-trace.jsonl"
