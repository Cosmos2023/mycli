from mycli.domain.runtime import HistoryItem, HistoryItemType
from mycli.services.history_replay import normalize_history_for_replay


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
        _item("approval", "turn-2", HistoryItemType.APPROVAL_RESOLUTION),
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

    normalized = normalize_history_for_replay(history)

    assert [entry.id for entry in normalized] == [
        "user-original",
        "approval",
        "user-queued",
        "user-repeat",
    ]


def test_normalizer_does_not_remove_user_before_approval_resolution() -> None:
    history = (
        _item("user", "turn-1", HistoryItemType.USER_MESSAGE, text="inspect cpu"),
        _item("approval", "turn-1", HistoryItemType.APPROVAL_RESOLUTION),
    )

    assert normalize_history_for_replay(history) == history
