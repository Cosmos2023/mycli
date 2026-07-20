from pathlib import Path
from unittest.mock import Mock

import pytest

from mycli.application.runtime.session_queue import (
    QueueCapacityError,
    QueueConflictError,
    SessionQueueCoordinator,
)
from mycli.domain.runtime import QueueCapacity, QueueDisposition
from mycli.services.session_service import SessionService


def _coordinator(
    tmp_path: Path,
    *,
    capacity: QueueCapacity = QueueCapacity(),
) -> SessionQueueCoordinator:
    return SessionQueueCoordinator(
        session_id="demo",
        session_service=SessionService(home_dir=tmp_path),
        capacity=capacity,
    )


def test_coordinator_accepts_rejects_and_prioritizes_steers(tmp_path: Path) -> None:
    queue = _coordinator(tmp_path)

    accepted = queue.enqueue_steer(
        text="inspect",
        client_turn_id="client-1",
        expected_turn_id="turn-1",
        active_turn_id="turn-1",
        steerable=True,
    )
    rejected = queue.enqueue_steer(
        text="retry",
        client_turn_id="client-2",
        expected_turn_id="turn-old",
        active_turn_id="turn-1",
        steerable=True,
    )
    queue.enqueue_follow_up(text="later", client_turn_id="client-3")

    assert accepted.disposition is QueueDisposition.ACCEPTED_FOR_TURN
    assert rejected.disposition is QueueDisposition.DEFERRED_TO_END_OF_TURN
    assert queue.next_end_of_turn().text == "retry"
    queue.mark_started(rejected.record.queue_id)
    assert queue.next_end_of_turn().text == "later"


def test_coordinator_deduplicates_and_rejects_conflicting_client_ids(
    tmp_path: Path,
) -> None:
    queue = _coordinator(tmp_path)
    first = queue.enqueue_follow_up(text="same", client_turn_id="client-1")
    duplicate = queue.enqueue_follow_up(text="same", client_turn_id="client-1")
    assert duplicate.disposition is QueueDisposition.DUPLICATE
    assert duplicate.record.queue_id == first.record.queue_id
    with pytest.raises(QueueConflictError):
        queue.enqueue_follow_up(text="different", client_turn_id="client-1")


def test_coordinator_recovers_history_committed_queue_ids(tmp_path: Path) -> None:
    service = SessionService(home_dir=tmp_path)
    queue = SessionQueueCoordinator(session_id="demo", session_service=service)
    queued = queue.enqueue_steer(
        text="inspect",
        client_turn_id="client-1",
        expected_turn_id="turn-1",
        active_turn_id="turn-1",
        steerable=True,
    ).record

    restored = SessionQueueCoordinator.restore(
        session_id="demo",
        session_service=service,
        committed_queue_ids={queued.queue_id},
        active_turn_id=None,
    )

    assert restored.snapshot().active_records() == ()


@pytest.mark.parametrize(
    ("capacity", "text", "images"),
    [
        (QueueCapacity(max_records=0), "x", ()),
        (QueueCapacity(max_text_bytes=0), "x", ()),
        (QueueCapacity(max_total_text_bytes=0), "x", ()),
        (QueueCapacity(max_attachments=0), "x", ("/tmp/a.png",)),
    ],
)
def test_coordinator_enforces_each_capacity_limit(
    tmp_path: Path,
    capacity: QueueCapacity,
    text: str,
    images: tuple[str, ...],
) -> None:
    queue = _coordinator(tmp_path, capacity=capacity)
    with pytest.raises(QueueCapacityError):
        queue.enqueue_follow_up(
            text=text,
            image_paths=images,
            client_turn_id="client-capacity",
        )


def test_failed_persistence_does_not_publish_candidate_state(tmp_path: Path) -> None:
    queue = _coordinator(tmp_path)
    queue._session_service.save_queue_snapshot = Mock(side_effect=OSError("disk full"))

    with pytest.raises(OSError, match="disk full"):
        queue.enqueue_follow_up(text="later", client_turn_id="client-1")

    assert queue.snapshot().active_records() == ()


def test_task_notification_capacity_replaces_oldest_internal_record(tmp_path: Path) -> None:
    queue = _coordinator(tmp_path, capacity=QueueCapacity(max_records=1))
    queue.enqueue_steer(
        text="old notification",
        client_turn_id="task-old",
        expected_turn_id="turn-1",
        active_turn_id="turn-1",
        steerable=True,
        source="task_notification",
    )
    queue.enqueue_steer(
        text="new notification",
        client_turn_id="task-new",
        expected_turn_id="turn-1",
        active_turn_id="turn-1",
        steerable=True,
        source="task_notification",
    )

    assert [item.text for item in queue.snapshot().pending_steers] == [
        "new notification"
    ]


def test_listener_runs_after_coordinator_lock_is_released(tmp_path: Path) -> None:
    queue = _coordinator(tmp_path)
    observed: list[int] = []
    unsubscribe = queue.subscribe(lambda _snapshot: observed.append(queue.snapshot().revision))

    queue.enqueue_follow_up(text="later", client_turn_id="client-1")
    unsubscribe()
    queue.enqueue_follow_up(text="last", client_turn_id="client-2")

    assert observed == [1]


def test_mark_started_only_removes_current_priority_record(tmp_path: Path) -> None:
    queue = _coordinator(tmp_path)
    first = queue.enqueue_follow_up(text="first", client_turn_id="client-1").record
    second = queue.enqueue_follow_up(text="second", client_turn_id="client-2").record

    with pytest.raises(QueueConflictError):
        queue.mark_started(second.queue_id)

    assert queue.next_end_of_turn() == first
