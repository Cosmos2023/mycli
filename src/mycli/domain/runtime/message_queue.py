from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime
from enum import StrEnum
from typing import Literal

QueuedInputKind = Literal["steering", "follow_up"]
QueueActivityKind = Literal["idle", "pending_input"]
QueueItemKind = Literal["pending_steer", "rejected_steer", "follow_up"]
QueueDeliveryState = Literal["queued", "accepted", "committed"]


class QueueDisposition(StrEnum):
    ACCEPTED_FOR_TURN = "accepted_for_turn"
    DEFERRED_TO_END_OF_TURN = "deferred_to_end_of_turn"
    QUEUED_FOLLOW_UP = "queued_follow_up"
    DUPLICATE = "duplicate"


@dataclass(slots=True, frozen=True)
class QueueCapacity:
    max_records: int = 128
    max_text_bytes: int = 64 * 1024
    max_total_text_bytes: int = 512 * 1024
    max_attachments: int = 16


@dataclass(slots=True, frozen=True)
class QueuedInputRecord:
    queue_id: str
    session_id: str
    client_turn_id: str
    target_turn_id: str | None
    kind: QueueItemKind
    state: QueueDeliveryState
    text: str
    image_paths: tuple[str, ...]
    source: str
    created_at: str
    updated_at: str

    def __post_init__(self) -> None:
        for field_name in ("queue_id", "session_id", "client_turn_id", "text", "source"):
            value = getattr(self, field_name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"{field_name} must be a non-empty string")
            object.__setattr__(self, field_name, value.strip())
        if self.kind not in {"pending_steer", "rejected_steer", "follow_up"}:
            raise ValueError("invalid kind")
        if self.state not in {"queued", "accepted", "committed"}:
            raise ValueError("invalid state")
        target_turn_id = self.target_turn_id
        if target_turn_id is not None:
            if not isinstance(target_turn_id, str) or not target_turn_id.strip():
                raise ValueError("target_turn_id must be a non-empty string or null")
            target_turn_id = target_turn_id.strip()
            object.__setattr__(self, "target_turn_id", target_turn_id)
        if self.kind == "pending_steer" and target_turn_id is None:
            raise ValueError("pending_steer requires target_turn_id")
        if self.kind == "follow_up" and target_turn_id is not None:
            raise ValueError("follow_up cannot have target_turn_id")
        if not isinstance(self.image_paths, tuple) or not all(
            isinstance(path, str) and path for path in self.image_paths
        ):
            raise ValueError("image_paths must contain non-empty strings")
        object.__setattr__(self, "image_paths", tuple(dict.fromkeys(self.image_paths)))
        for field_name in ("created_at", "updated_at"):
            value = getattr(self, field_name)
            if not isinstance(value, str) or not value:
                raise ValueError(f"{field_name} must be a non-empty string")

    @classmethod
    def create(
        cls,
        *,
        queue_id: str,
        session_id: str,
        client_turn_id: str,
        target_turn_id: str | None,
        kind: QueueItemKind,
        text: str,
        image_paths: tuple[str, ...] = (),
        source: str = "user",
        now: datetime | None = None,
    ) -> QueuedInputRecord:
        timestamp = (now or datetime.now(UTC)).isoformat()
        return cls(
            queue_id=queue_id,
            session_id=session_id,
            client_turn_id=client_turn_id,
            target_turn_id=target_turn_id,
            kind=kind,
            state="accepted" if kind == "pending_steer" else "queued",
            text=text,
            image_paths=tuple(path for path in image_paths if path),
            source=source,
            created_at=timestamp,
            updated_at=timestamp,
        )

    def transition(
        self,
        *,
        kind: QueueItemKind | None = None,
        state: QueueDeliveryState | None = None,
        now: datetime | None = None,
    ) -> QueuedInputRecord:
        return replace(
            self,
            kind=kind or self.kind,
            state=state or self.state,
            updated_at=(now or datetime.now(UTC)).isoformat(),
        )

    def to_dict(self) -> dict[str, object]:
        payload = asdict(self)
        payload["image_paths"] = list(self.image_paths)
        return payload

    @classmethod
    def from_dict(cls, payload: object) -> QueuedInputRecord:
        if not isinstance(payload, dict):
            raise ValueError("record must be an object")
        required_strings = (
            "queue_id",
            "session_id",
            "client_turn_id",
            "kind",
            "state",
            "text",
            "source",
            "created_at",
            "updated_at",
        )
        values: dict[str, str] = {}
        for field_name in required_strings:
            value = payload.get(field_name)
            if not isinstance(value, str) or not value:
                raise ValueError(f"missing {field_name}")
            values[field_name] = value
        target_turn_id = payload.get("target_turn_id")
        if target_turn_id is not None and not isinstance(target_turn_id, str):
            raise ValueError("target_turn_id must be a string or null")
        image_paths = payload.get("image_paths")
        if not isinstance(image_paths, list) or not all(
            isinstance(path, str) and path for path in image_paths
        ):
            raise ValueError("image_paths must be a list of non-empty strings")
        return cls(
            queue_id=values["queue_id"],
            session_id=values["session_id"],
            client_turn_id=values["client_turn_id"],
            target_turn_id=target_turn_id,
            kind=values["kind"],  # type: ignore[arg-type]
            state=values["state"],  # type: ignore[arg-type]
            text=values["text"],
            image_paths=tuple(image_paths),
            source=values["source"],
            created_at=values["created_at"],
            updated_at=values["updated_at"],
        )


@dataclass(slots=True, frozen=True)
class QueueSnapshot:
    session_id: str
    revision: int = 0
    pending_steers: tuple[QueuedInputRecord, ...] = ()
    rejected_steers: tuple[QueuedInputRecord, ...] = ()
    follow_ups: tuple[QueuedInputRecord, ...] = ()

    def __post_init__(self) -> None:
        if not isinstance(self.session_id, str) or not self.session_id.strip():
            raise ValueError("session_id must be a non-empty string")
        object.__setattr__(self, "session_id", self.session_id.strip())
        if isinstance(self.revision, bool) or not isinstance(self.revision, int) or self.revision < 0:
            raise ValueError("revision must be a non-negative integer")
        for field_name, expected_kind in (
            ("pending_steers", "pending_steer"),
            ("rejected_steers", "rejected_steer"),
            ("follow_ups", "follow_up"),
        ):
            records = getattr(self, field_name)
            if not isinstance(records, tuple):
                raise ValueError(f"{field_name} must be a tuple")
            for record in records:
                if record.session_id != self.session_id:
                    raise ValueError(f"{field_name} record session does not match snapshot")
                if record.kind != expected_kind:
                    raise ValueError(f"{field_name} contains {record.kind}")

    def active_records(self) -> tuple[QueuedInputRecord, ...]:
        return (*self.pending_steers, *self.rejected_steers, *self.follow_ups)

    def to_dict(self) -> dict[str, object]:
        return {
            "session_id": self.session_id,
            "revision": self.revision,
            "pending_steers": [record.to_dict() for record in self.pending_steers],
            "rejected_steers": [record.to_dict() for record in self.rejected_steers],
            "follow_ups": [record.to_dict() for record in self.follow_ups],
        }

    @classmethod
    def from_dict(cls, payload: object) -> QueueSnapshot:
        snapshot, issues = cls.restore(payload)
        if issues:
            raise ValueError(issues[0])
        return snapshot

    @classmethod
    def restore(cls, payload: object) -> tuple[QueueSnapshot, tuple[str, ...]]:
        if not isinstance(payload, dict):
            raise ValueError("snapshot must be an object")
        session_id = payload.get("session_id")
        if not isinstance(session_id, str) or not session_id.strip():
            raise ValueError("missing session_id")
        revision = payload.get("revision")
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
            raise ValueError("revision must be a non-negative integer")
        restored: dict[str, tuple[QueuedInputRecord, ...]] = {}
        issues: list[str] = []
        for field_name, expected_kind in (
            ("pending_steers", "pending_steer"),
            ("rejected_steers", "rejected_steer"),
            ("follow_ups", "follow_up"),
        ):
            raw_records = payload.get(field_name)
            if not isinstance(raw_records, list):
                raise ValueError(f"{field_name} must be a list")
            records: list[QueuedInputRecord] = []
            for index, raw_record in enumerate(raw_records):
                try:
                    record = QueuedInputRecord.from_dict(raw_record)
                    if record.session_id != session_id.strip():
                        raise ValueError("session_id does not match snapshot")
                    if record.kind != expected_kind:
                        raise ValueError(f"expected {expected_kind}, got {record.kind}")
                except ValueError as exc:
                    issues.append(f"{field_name}[{index}]: {exc}")
                    continue
                records.append(record)
            restored[field_name] = tuple(records)
        return (
            cls(
                session_id=session_id,
                revision=revision,
                pending_steers=restored["pending_steers"],
                rejected_steers=restored["rejected_steers"],
                follow_ups=restored["follow_ups"],
            ),
            tuple(issues),
        )


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
    "QueueCapacity",
    "QueueDeliveryState",
    "QueueDisposition",
    "QueueItemKind",
    "QueueSnapshot",
    "QueuedInputRecord",
    "QueuedInputKind",
    "QueuedTurnInput",
    "QueuedTurnSnapshot",
    "queue_activity",
    "queue_snapshot_texts",
]
