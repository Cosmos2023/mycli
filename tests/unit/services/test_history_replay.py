from mycli.domain.runtime import (
    HistoryItem,
    HistoryItemType,
    TurnRollout,
    TurnRolloutEvent,
    TurnStatus,
)
from mycli.services.history_replay import (
    approval_resume_turn_ids,
    normalize_history_for_replay,
)


def _item(
    item_id: str,
    turn_id: str,
    item_type: HistoryItemType,
    *,
    text: str = "",
    queued: bool = False,
) -> HistoryItem:
    return HistoryItem(
        id=item_id,
        thread_id="demo",
        turn_id=turn_id,
        type=item_type,
        text=text,
        metadata={"queued": True} if queued else {},
    )


def test_normalizer_removes_only_legacy_approval_resume_user_item() -> None:
    history = (
        _item("user-original", "turn-1", HistoryItemType.USER_MESSAGE, text="inspect cpu"),
        _item("user-legacy", "turn-2", HistoryItemType.USER_MESSAGE, text="inspect cpu"),
        _item(
            "user-queued",
            "turn-2",
            HistoryItemType.USER_MESSAGE,
            text="also inspect disk",
            queued=True,
        ),
        _item("user-repeat", "turn-3", HistoryItemType.USER_MESSAGE, text="inspect cpu"),
    )

    normalized = normalize_history_for_replay(
        history,
        approval_turn_ids=frozenset({"turn-2"}),
    )

    assert [entry.id for entry in normalized] == [
        "user-original",
        "user-queued",
        "user-repeat",
    ]


def test_normalizer_preserves_users_outside_approval_resume_turns() -> None:
    history = (_item("user", "turn-1", HistoryItemType.USER_MESSAGE, text="inspect cpu"),)

    assert normalize_history_for_replay(history, approval_turn_ids=frozenset()) == history


def test_approval_resume_turn_ids_uses_rollout_turn_items() -> None:
    rollout = TurnRollout(
        thread_id="demo",
        turn_id="turn-approval",
        status=TurnStatus.COMPLETED,
        started_at="2026-07-14T00:00:00Z",
        completed_at="2026-07-14T00:00:01Z",
        events=(
            TurnRolloutEvent(
                event_id="event-1",
                kind="turn_item",
                created_at="2026-07-14T00:00:00Z",
                payload={"type": "approval_resolution", "text": "[decision] 1"},
            ),
        ),
    )

    assert approval_resume_turn_ids((rollout,)) == frozenset({"turn-approval"})
