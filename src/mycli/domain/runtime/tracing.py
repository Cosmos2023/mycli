from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True, frozen=True)
class RuntimeTraceEvent:
    kind: str
    turn_id: str
    payload: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "turn_id": self.turn_id,
            "payload": self.payload,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "RuntimeTraceEvent":
        raw_payload = payload.get("payload")
        if not isinstance(raw_payload, dict):
            raw_payload = {}
        return cls(
            kind=str(payload["kind"]),
            turn_id=str(payload["turn_id"]),
            payload=raw_payload,
        )


__all__ = ["RuntimeTraceEvent"]
