from __future__ import annotations

from mycli.domain.runtime import (
    CanonicalTimelineDurability,
    CanonicalTimelineItem,
    CanonicalTimelineRole,
    CanonicalTimelineScope,
    TurnContextCacheClass,
)


def test_canonical_timeline_item_round_trips_persistence_contract() -> None:
    item = CanonicalTimelineItem(
        role=CanonicalTimelineRole.DEVELOPER,
        kind="memory",
        content="<memory-context>Use the stable API.</memory-context>",
        source="memory",
        durability=CanonicalTimelineDurability.PERSISTENT,
        scope=CanonicalTimelineScope.TRANSCRIPT,
        cache_class=TurnContextCacheClass.DYNAMIC,
        metadata={"record_count": 1},
        provider_state={"codex_reasoning_items": [{"encrypted_content": "opaque"}]},
    )

    restored = CanonicalTimelineItem.from_dict(item.to_dict())

    assert restored == item
    assert restored.is_model_visible is True
    assert restored.is_replayable is True


def test_api_only_canonical_timeline_item_is_not_model_visible_or_replayable() -> None:
    item = CanonicalTimelineItem(
        role=CanonicalTimelineRole.DEVELOPER,
        kind="transport_retry_notice",
        content="retry request id req_123",
        durability=CanonicalTimelineDurability.API_ONLY,
        scope=CanonicalTimelineScope.REQUEST,
        cache_class=TurnContextCacheClass.EPHEMERAL,
    )

    assert item.is_model_visible is False
    assert item.is_replayable is False
