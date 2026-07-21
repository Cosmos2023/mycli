from pathlib import Path

from mycli.application.runtime.runtime_notification_inbox import (
    RuntimeNotificationInbox,
)
from mycli.domain.runtime.task_notifications import TaskNotification


def test_runtime_notification_inbox_drains_fifo_records_once() -> None:
    inbox = RuntimeNotificationInbox()

    inbox.enqueue_task_notification(
        TaskNotification(
            task_id="task-1",
            status="completed",
            summary="first",
            output_file=Path("/tmp/first.log"),
        )
    )
    inbox.enqueue_serialized(
        "<task-notification>second</task-notification>",
        metadata={"task_id": "task-2", "source": "legacy_queue"},
    )

    records = inbox.drain()

    assert [record.metadata["task_id"] for record in records] == ["task-1", "task-2"]
    assert records[0].content.startswith("<task-notification>")
    assert records[0].metadata["source"] == "task_notification"
    assert records[1].content.endswith("</task-notification>")
    assert inbox.drain() == ()


def test_runtime_notification_inbox_snapshots_without_consuming() -> None:
    inbox = RuntimeNotificationInbox()
    inbox.enqueue_serialized("notice", metadata={"task_id": "task-1"})

    assert inbox.snapshot() == inbox.snapshot()
    assert len(inbox.drain()) == 1
