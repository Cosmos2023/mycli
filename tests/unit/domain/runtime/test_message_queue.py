from datetime import UTC, datetime

import pytest

from mycli.domain.runtime import (
    QueueCapacity,
    QueueDisposition,
    QueueSnapshot,
    QueuedInputRecord,
)


def test_queue_snapshot_round_trip_preserves_three_classes() -> None:
    now = datetime(2026, 7, 20, tzinfo=UTC)
    pending = QueuedInputRecord.create(
        queue_id="queue-1",
        session_id="session-1",
        client_turn_id="client-1",
        target_turn_id="turn-1",
        kind="pending_steer",
        text="inspect output",
        image_paths=("/tmp/a.png",),
        source="user",
        now=now,
    )
    rejected = pending.transition(kind="rejected_steer", state="queued", now=now)
    follow_up = QueuedInputRecord.create(
        queue_id="queue-2",
        session_id="session-1",
        client_turn_id="client-2",
        target_turn_id=None,
        kind="follow_up",
        text="summarize",
        now=now,
    )
    snapshot = QueueSnapshot(
        session_id="session-1",
        revision=3,
        pending_steers=(pending,),
        rejected_steers=(rejected,),
        follow_ups=(follow_up,),
    )

    assert QueueSnapshot.from_dict(snapshot.to_dict()) == snapshot
    assert QueueDisposition.ACCEPTED_FOR_TURN.value == "accepted_for_turn"


def test_queue_record_rejects_invalid_target_and_capacity_defaults_are_fixed() -> None:
    with pytest.raises(ValueError, match="target_turn_id"):
        QueuedInputRecord.create(
            queue_id="queue-1",
            session_id="session-1",
            client_turn_id="client-1",
            target_turn_id=None,
            kind="pending_steer",
            text="inspect",
        )

    assert QueueCapacity().max_records == 128
    assert QueueCapacity().max_text_bytes == 64 * 1024
    assert QueueCapacity().max_total_text_bytes == 512 * 1024
    assert QueueCapacity().max_attachments == 16


def test_queue_snapshot_restore_quarantines_only_invalid_records() -> None:
    valid = QueuedInputRecord.create(
        queue_id="queue-good",
        session_id="session-1",
        client_turn_id="client-good",
        target_turn_id=None,
        kind="follow_up",
        text="good",
        now=datetime(2026, 7, 20, tzinfo=UTC),
    )
    payload = QueueSnapshot(
        session_id="session-1",
        revision=2,
        follow_ups=(valid,),
    ).to_dict()
    payload["follow_ups"].append({"queue_id": "queue-bad"})

    snapshot, issues = QueueSnapshot.restore(payload)

    assert [item.queue_id for item in snapshot.follow_ups] == ["queue-good"]
    assert issues == ("follow_ups[1]: missing session_id",)
