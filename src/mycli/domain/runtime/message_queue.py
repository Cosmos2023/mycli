from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

QueuedInputKind = Literal["steering", "follow_up"]
QueueActivityKind = Literal["idle", "pending_input"]


@dataclass(slots=True, frozen=True)
class QueuedTurnInput:
    kind: QueuedInputKind
    text: str
    image_paths: tuple[str, ...] = ()
    client_turn_id: str | None = None
    source: str = "user"

    def __post_init__(self) -> None:
        text = self.text.strip()
        if not text:
            raise ValueError("queued input requires text")
        object.__setattr__(self, "text", text)
        object.__setattr__(
            self,
            "image_paths",
            tuple(dict.fromkeys(path for path in self.image_paths if path)),
        )

    def to_legacy_text(self) -> str:
        return self.text

    def to_gateway_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "kind": self.kind,
            "message": self.text,
            "text": self.text,
            "source": self.source,
        }
        if self.image_paths:
            payload["local_images"] = [
                {"path": path, "placeholder": f"[image #{index}]"}
                for index, path in enumerate(self.image_paths, start=1)
            ]
        if self.client_turn_id:
            payload["client_turn_id"] = self.client_turn_id
        return payload


QueuedTurnSnapshot = tuple[tuple[QueuedTurnInput, ...], tuple[QueuedTurnInput, ...]]


@dataclass(slots=True, frozen=True)
class QueueActivity:
    kind: QueueActivityKind
    has_pending_input: bool
    steering_count: int = 0
    follow_up_count: int = 0

    def to_gateway_payload(self) -> dict[str, object]:
        return {
            "kind": self.kind,
            "has_pending_input": self.has_pending_input,
            "steering_count": self.steering_count,
            "follow_up_count": self.follow_up_count,
        }


def queue_snapshot_texts(
    snapshot: QueuedTurnSnapshot,
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    steering, follow_up = snapshot
    return (
        tuple(item.to_legacy_text() for item in steering),
        tuple(item.to_legacy_text() for item in follow_up),
    )


def queue_activity(snapshot: QueuedTurnSnapshot) -> QueueActivity:
    steering, follow_up = snapshot
    steering_count = len(steering)
    follow_up_count = len(follow_up)
    has_pending_input = steering_count > 0 or follow_up_count > 0
    return QueueActivity(
        kind="pending_input" if has_pending_input else "idle",
        has_pending_input=has_pending_input,
        steering_count=steering_count,
        follow_up_count=follow_up_count,
    )


__all__ = [
    "QueueActivity",
    "QueueActivityKind",
    "QueuedInputKind",
    "QueuedTurnInput",
    "QueuedTurnSnapshot",
    "queue_activity",
    "queue_snapshot_texts",
]
