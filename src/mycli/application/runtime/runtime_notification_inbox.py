from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from threading import Lock

from mycli.domain.runtime.task_notifications import TaskNotification


@dataclass(frozen=True, slots=True)
class RuntimeNotificationRecord:
    content: str
    metadata: dict[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.content, str) or not self.content.strip():
            raise ValueError("notification content must be non-empty")
        object.__setattr__(self, "content", self.content.strip())
        object.__setattr__(self, "metadata", dict(self.metadata))


class RuntimeNotificationInbox:
    def __init__(self) -> None:
        self._lock = Lock()
        self._records: deque[RuntimeNotificationRecord] = deque()

    def enqueue_task_notification(self, notification: TaskNotification) -> None:
        metadata: dict[str, object] = {
            "source": "task_notification",
            "task_id": notification.task_id,
            "status": notification.status,
        }
        if notification.task_type is not None:
            metadata["task_type"] = notification.task_type
        if notification.output_file is not None:
            metadata["output_file"] = str(notification.output_file)
        self.enqueue_serialized(notification.to_xml(), metadata=metadata)

    def enqueue_serialized(
        self,
        content: str,
        *,
        metadata: dict[str, object] | None = None,
    ) -> None:
        record = RuntimeNotificationRecord(content=content, metadata=dict(metadata or {}))
        with self._lock:
            self._records.append(record)

    def snapshot(self) -> tuple[RuntimeNotificationRecord, ...]:
        with self._lock:
            return tuple(self._records)

    def drain(self) -> tuple[RuntimeNotificationRecord, ...]:
        with self._lock:
            records = tuple(self._records)
            self._records.clear()
            return records


__all__ = ["RuntimeNotificationInbox", "RuntimeNotificationRecord"]
