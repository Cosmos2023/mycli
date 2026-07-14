from __future__ import annotations

from mycli.domain.runtime import HistoryItem, HistoryItemType, TurnRollout


def approval_resume_turn_ids(
    rollouts: tuple[TurnRollout, ...],
) -> frozenset[str]:
    return frozenset(
        rollout.turn_id
        for rollout in rollouts
        if any(
            event.kind == "turn_item"
            and event.payload.get("type") == HistoryItemType.APPROVAL_RESOLUTION.value
            for event in rollout.events
        )
    )


def normalize_history_for_replay(
    items: tuple[HistoryItem, ...],
    *,
    approval_turn_ids: frozenset[str],
) -> tuple[HistoryItem, ...]:
    normalized: list[HistoryItem] = []
    for item in items:
        if (
            item.type is HistoryItemType.USER_MESSAGE
            and item.turn_id in approval_turn_ids
            and item.metadata.get("queued") is not True
        ):
            continue
        normalized.append(item)
    return tuple(normalized)


__all__ = ["approval_resume_turn_ids", "normalize_history_for_replay"]
