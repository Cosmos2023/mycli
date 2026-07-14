from __future__ import annotations

from mycli.domain.runtime import HistoryItem, HistoryItemType


def normalize_history_for_replay(
    items: tuple[HistoryItem, ...],
) -> tuple[HistoryItem, ...]:
    normalized: list[HistoryItem] = []
    approval_turn_ids: set[str] = set()
    for item in items:
        if item.type is HistoryItemType.APPROVAL_RESOLUTION:
            approval_turn_ids.add(item.turn_id)
            normalized.append(item)
            continue
        if (
            item.type is HistoryItemType.USER_MESSAGE
            and item.turn_id in approval_turn_ids
            and item.metadata.get("queued") is not True
        ):
            continue
        normalized.append(item)
    return tuple(normalized)


__all__ = ["normalize_history_for_replay"]
